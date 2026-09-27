# Extension panel development

The in-page Formwork panel uses React and strict TypeScript. Source lives in
`extension-ui/`; `extension/src/content/index.js` is its generated, bundled
production artifact. React is bundled locally, with no CDN, eval, or remote code.

```sh
npm ci
npm run build:extension
npm run typecheck:extension
```

Firefox/Zen packaging (`python3 tools/build-firefox.py --out /tmp/formwork.xpi`)
always rebuilds first. The syntax/manifest verification step also rebuilds and
typechecks so verification cannot pass against an outdated bundle. Commit the
source and generated artifact together: unpacked Chrome installations use the
same artifact as Firefox. Changes require reloading the extension and invoking
its toolbar action in an existing application tab.

- `Panel.tsx` owns job context, progress, receipts and posting analysis.
- `DraftCard.tsx` owns editable drafts, revision instructions and approval.
- `frame.ts` coordinates scraping, planning, attachments and fills in each frame.
- `mount.ts` owns the movable launcher, hydration recovery and extension upgrades.
- `types.ts` defines the panel/background message contracts; `engine.ts` describes
  the existing form engine boundary.

Closing the panel detaches its host without unmounting React. This preserves
edited drafts and pending operations. Each new extension instance claims page
ownership; older hydration observers must not resurrect retired panels.

This migration covers the application panel and frame coordinator. Existing
scraping/fill adapters, background libraries and standalone settings/setup pages
remain JavaScript. The separate Python web dashboard is maintained independently.
A React panel does not change the host application's Workday widgets: those still
require their own search, selection and retained-chip verification.
