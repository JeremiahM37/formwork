/** Run the whole dashboard suite with its dependencies, never a silently skipped API suite. */
import {spawnSync} from "node:child_process";
import {homedir} from "node:os";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [process.env.FORMWORK_TEST_PYTHON, join(root, ".venv/bin/python"),
  join(homedir(), ".venvs/formwork-dashboard/bin/python"), "python3"].filter(Boolean);
const python = candidates.find(path => spawnSync(path, ["-c", "import fastapi,httpx,docx,pypdf,pycountry,authlib"]).status === 0);
if (!python) {
  console.error("Install server/requirements.txt in a virtualenv and set FORMWORK_TEST_PYTHON to its Python executable.");
  process.exit(1);
}
const result = spawnSync(python, ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], {cwd:root, stdio:"inherit"});
process.exit(result.status ?? 1);
