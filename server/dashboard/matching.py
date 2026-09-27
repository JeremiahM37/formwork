"""Inspectable keyword evidence. Coverage is not an ATS score or hiring probability."""
import html
import json
import re

CATALOG = {
    "Python": ["python"], "JavaScript": ["javascript"], "TypeScript": ["typescript"],
    "Go": ["golang", "Go"], "Rust": ["rust"], "Java": ["java"], "C++": ["c++"],
    "C#": ["c#", "csharp"], "C": ["C"], "Ruby": ["ruby"], "PHP": ["php"],
    "SQL": ["sql"], "PostgreSQL": ["postgresql", "postgres"], "MySQL": ["mysql"],
    "Redis": ["redis"], "MongoDB": ["mongodb"], "SQLite": ["sqlite"],
    "React": ["react", "reactjs"], "Vue": ["vue", "vuejs"], "Angular": ["angular"],
    "Node.js": ["node.js", "nodejs"], "Django": ["django"], "FastAPI": ["fastapi"],
    "AWS": ["aws", "amazon web services"], "Azure": ["azure"], "GCP": ["gcp", "google cloud"],
    "Docker": ["docker"], "Kubernetes": ["kubernetes", "k8s"], "Terraform": ["terraform"],
    "Linux": ["linux"], "Git": ["git"], "CI/CD": ["ci/cd", "continuous integration"],
    "GraphQL": ["graphql"], "REST": ["REST", "restful"], "gRPC": ["grpc"],
    "Kafka": ["kafka"], "Spark": ["spark"], "Airflow": ["airflow"],
    "PyTorch": ["pytorch"], "TensorFlow": ["tensorflow"], "CUDA": ["cuda"],
    "Machine learning": ["machine learning"], "Distributed systems": ["distributed systems"],
    "Networking": ["networking"], "Security": ["security"], "TLS": ["tls"],
    "Verilog": ["verilog"], "FPGA": ["fpga"], "Embedded": ["embedded"],
    "Excel": ["excel"], "Salesforce": ["salesforce"], "Figma": ["figma"],
    "Project management": ["project management"], "Accounting": ["accounting"],
}


def plain(text):
    return html.unescape(re.sub(r"<[^>]+>", " ", str(text or "")))


def occurrence(text, aliases):
    for term in aliases:
        # 'go' and 'rest' in ordinary English aren't technology evidence.
        flags = 0 if term in {"Go", "C", "REST"} else re.I
        match = re.search(r"(?<![\w+#])" + re.escape(term) + r"(?![\w+#])", text, flags)
        if match:
            return re.sub(r"\s+", " ", text[max(0, match.start()-55):match.end()+75]).strip()
    return ""


def fit(posting, profile, resume_text=""):
    posting = plain(posting)
    # Identity/preferences cannot supply evidence of a skill.
    evidence = "\n".join([resume_text, json.dumps({k: profile.get(k) for k in
        ("skills", "experience", "projects", "education", "certifications")}, ensure_ascii=False)])
    matched, missing = [], []
    catalog=dict(CATALOG)
    skills=profile.get('skills',{})
    values=[item for group in skills.values() if isinstance(group,list) for item in group] if isinstance(skills,dict) else skills if isinstance(skills,list) else []
    known={alias.casefold() for aliases in catalog.values() for alias in aliases}
    for value in values:
        if isinstance(value,str) and 3 <= len(value.strip()) <= 100 and value.strip().casefold() not in known:
            catalog[value.strip()]=[value.strip()]
            known.add(value.strip().casefold())
    for name, aliases in catalog.items():
        requirement = occurrence(posting, aliases)
        if not requirement:
            continue
        source = occurrence(evidence, aliases)
        item = {"skill": name, "posting": requirement}
        if source:
            matched.append({**item, "evidence": source})
        else:
            missing.append(item)
    total = len(matched) + len(missing)
    return {"matched": matched, "missing": missing,
            "coverage": round(100 * len(matched) / total) if total else None,
            "recognized": total, "descriptionAvailable": bool(posting.strip()),
            "explanation": "Keyword coverage among recognized skills. Missing means not evidenced in your profile; the posting may list optional skills. No keywords recognized means unknown, not a perfect match."}
