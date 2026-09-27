"""Google OAuth and private token storage. Account access begins at explicit consent."""
from __future__ import annotations
import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import secrets
import time
from urllib.parse import urlsplit
import httpx
from authlib.integrations.httpx_client import AsyncOAuth2Client
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator
from .config import STATE_DIR, EXTENSION_DASHBOARD_URL
from . import store

router=APIRouter(prefix='/api/connections/google')
LOCK=asyncio.Lock()
PRIVATE=STATE_DIR/'connections'/'google.json'
AUTH='https://accounts.google.com/o/oauth2/v2/auth'
TOKEN='https://oauth2.googleapis.com/token'
REVOKE='https://oauth2.googleapis.com/revoke'
GMAIL_SCOPE='https://www.googleapis.com/auth/gmail.readonly'
CALENDAR_SCOPE='https://www.googleapis.com/auth/calendar.events'
CALLBACK='/api/connections/google/callback'
COOKIE='formwork_google_connect'


def load():
    try: return json.loads(PRIVATE.read_text())
    except FileNotFoundError: return {}
    except (OSError,ValueError): raise HTTPException(503,'Google connection storage is unreadable') from None


def save(data):
    PRIVATE.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    PRIVATE.parent.chmod(0o700)
    temp=PRIVATE.with_suffix('.'+secrets.token_hex(8)+'.tmp')
    try:
        fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as stream: json.dump(data,stream,separators=(',',':'))
        os.replace(temp,PRIVATE)
    finally:
        temp.unlink(missing_ok=True)


def public(data):
    config=data.get('config',{})
    return {'configured':bool(config.get('clientId') and config.get('clientSecret') and config.get('redirectUri')),
        'clientId':config.get('clientId',''),'hasClientSecret':bool(config.get('clientSecret')),
        'redirectUri':config.get('redirectUri',''),'connected':bool(data.get('token')),
        'account':data.get('account',''),'scopes':str(data.get('token',{}).get('scope','')).split(),
        'lastError':data.get('lastError',''),'lastSync':data.get('lastSync'),
        'localCallbackUri':EXTENSION_DASHBOARD_URL.rstrip('/')+CALLBACK,
        'syncPending':bool(data.get('mailPage')),'historyIdPresent':bool(data.get('historyId')),'autoSync':bool(data.get('autoSync'))}


class ConfigIn(BaseModel):
    clientId: str = Field(min_length=1,max_length=500)
    clientSecret: str = Field(default='',max_length=4096)
    redirectUri: str = Field(max_length=2000)

    @field_validator('redirectUri')
    @classmethod
    def redirect(cls,value):
        url=urlsplit(value)
        try: address=ipaddress.ip_address(url.hostname or '')
        except ValueError: address=None
        if address is not None and not address.is_loopback:
            raise ValueError('Google callbacks require a hostname or localhost')
        if url.hostname and url.hostname.endswith(('.internal','.local')):
            raise ValueError('Google does not accept private suffixes; use localhost or a public DNS hostname')
        if (not url.hostname or url.username or url.password or url.query or url.fragment or url.path!=CALLBACK
                or not (url.scheme=='https' or url.scheme=='http' and url.hostname in {'localhost','127.0.0.1'})):
            raise ValueError('Use an HTTPS callback URL, or HTTP localhost, ending in '+CALLBACK)
        return value


@router.get('')
async def status(): return public(load())


@router.post('/config')
async def configure(body: ConfigIn):
    async with LOCK:
        data=load()
        if data.get('token'): raise HTTPException(409,'Disconnect before changing OAuth credentials')
        config=body.model_dump()
        config['clientSecret']=body.clientSecret or data.get('config',{}).get('clientSecret','')
        if not config['clientSecret']: raise HTTPException(400,'Enter the OAuth client secret')
        data['config']=config;data.pop('pending',None);data['lastError']='';save(data)
        return public(data)


def oauth(config,**kwargs):
    return AsyncOAuth2Client(client_id=config['clientId'],client_secret=config['clientSecret'],
        redirect_uri=config['redirectUri'],token_endpoint_auth_method='client_secret_post',
        code_challenge_method='S256',timeout=30,**kwargs)


@router.post('/authorize')
async def authorize(request: Request,response: Response,calendar: bool=False):
    async with LOCK:
        data=load()
        if not public(data)['configured']: raise HTTPException(409,'Configure a Google OAuth web client first')
        config=data['config'];redirect=urlsplit(config['redirectUri'])
        if request.headers.get('host')!=redirect.netloc:
            raise HTTPException(409,'Open Formwork at the host registered in its callback URL before connecting')
        state=secrets.token_urlsafe(32);binding=secrets.token_urlsafe(32);verifier=secrets.token_urlsafe(48)
        scopes=GMAIL_SCOPE+(' '+CALENDAR_SCOPE if calendar else '')
        async with oauth(config,scope=scopes) as client:
            url,_=client.create_authorization_url(AUTH,state=state,code_verifier=verifier,
                access_type='offline',prompt='consent',include_granted_scopes='true')
        data['pending']={'scopes':scopes,'state':state,'binding':hashlib.sha256(binding.encode()).hexdigest(),'verifier':verifier,'expires':time.time()+600}
        save(data)
        response.set_cookie(COOKIE,binding,httponly=True,secure=redirect.scheme=='https',samesite='lax',max_age=600,path=CALLBACK)
        return {'url':url}


@router.get('/callback')
async def callback(request: Request,state: str='',code: str='',error: str=''):
    async with LOCK:
        data=load();pending=data.get('pending',{})
        binding=hashlib.sha256(request.cookies.get(COOKIE,'').encode()).hexdigest()
        if (not pending or pending.get('expires',0)<time.time() or
                not secrets.compare_digest(state,pending.get('state','')) or
                not secrets.compare_digest(binding,pending.get('binding',''))):
            raise HTTPException(400,'This Google connection request expired or belongs to another browser. Connect again.')
        data.pop('pending');save(data)
        if error or not code:
            data['lastError']='Google access was not granted. No account was connected.';save(data)
        else:
            try:
                async with oauth(data['config'],scope=pending.get('scopes',GMAIL_SCOPE)) as client:
                    token=await client.fetch_token(TOKEN,code=code,code_verifier=pending['verifier'],grant_type='authorization_code')
                if not set(pending.get('scopes',GMAIL_SCOPE).split()).issubset(str(token.get('scope','')).split()) or not token.get('access_token'):
                    raise ValueError('Required access was not granted')
                if not token.get('refresh_token') and data.get('token',{}).get('refresh_token'):
                    token['refresh_token']=data['token']['refresh_token']
                if not token.get('refresh_token'): raise ValueError('Offline access was not granted')
                # Identify the consenting mailbox before replacing an existing connection.
                async with httpx.AsyncClient(timeout=30) as client:
                    profile=await client.get('https://gmail.googleapis.com/gmail/v1/users/me/profile',headers={'Authorization':'Bearer '+token['access_token']})
                profile.raise_for_status();account=profile.json()['emailAddress']
                if data.get('account') and data['account']!=account:
                    raise ValueError('Disconnect the previous account before connecting a different mailbox')
                data.update(token=dict(token),account=account,lastError='');save(data)
            except Exception:
                data['lastError']='Google connection failed. Check the client, consent and offline-access settings, then connect again.';save(data)
        response=RedirectResponse('/#settings',status_code=303,headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'})
        response.delete_cookie(COOKIE,path=CALLBACK)
        return response


async def refresh(data):
    token=data.get('token',{})
    if not token.get('refresh_token'): raise HTTPException(409,'Connect Google again to restore offline access')
    try:
        async with oauth(data['config']) as client:
            fresh=await client.refresh_token(TOKEN,refresh_token=token['refresh_token'])
        fresh.setdefault('refresh_token',token['refresh_token'])
        fresh.setdefault('scope',token.get('scope',GMAIL_SCOPE))
        data['token']=dict(fresh);save(data)
    except Exception:
        data['lastError']='Google authorization expired or was revoked. Connect again.';save(data)
        raise HTTPException(409,data['lastError']) from None


async def google_get(data,path,params=None):
    """Caller holds LOCK. Paths are internal constants plus encoded provider IDs."""
    if not data.get('token'): raise HTTPException(409,'Connect Google before synchronizing')
    if data['token'].get('expires_at',0)<time.time()+60: await refresh(data)
    for attempt in range(2):
        async with httpx.AsyncClient(timeout=30) as client:
            response=await client.get('https://gmail.googleapis.com/gmail/v1/users/me/'+path,
                params=params,headers={'Authorization':'Bearer '+data['token']['access_token']})
        if response.status_code==401 and attempt==0: await refresh(data);continue
        return response


@router.post('/disconnect')
async def disconnect():
    async with LOCK:
        data=load();token=data.get('token',{})
        revoked=True
        if token:
            try:
                async with httpx.AsyncClient(timeout=20) as client:
                    result=await client.post(REVOKE,data={'token':token.get('refresh_token') or token['access_token']})
                revoked=result.status_code in {200,400}
            except httpx.HTTPError: revoked=False
        # Always remove local access, including a pending callback that could reconnect it.
        save({'config':data.get('config',{}),'lastError':'' if revoked else 'Disconnected locally. Remove Formwork in Google Account permissions to finish revocation.'})
        with store.db() as db:
            db.execute('DELETE FROM inbox_messages')
            db.execute('DELETE FROM calendar_events')
        return {'ok':True,'revoked':revoked}


class SyncSettingsIn(BaseModel):
    enabled: bool


@router.post('/sync-settings')
async def sync_settings(body: SyncSettingsIn):
    async with LOCK:
        data=load();data['autoSync']=body.enabled;save(data);return public(data)


class RedactOAuthCallback(logging.Filter):
    def filter(self,record):
        if isinstance(record.args,tuple):
            record.args=tuple(CALLBACK+'?[redacted]' if isinstance(arg,str) and arg.startswith(CALLBACK+'?') else arg for arg in record.args)
        return True


logging.getLogger('uvicorn.access').addFilter(RedactOAuthCallback())
