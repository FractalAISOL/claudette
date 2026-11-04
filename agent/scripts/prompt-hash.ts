import { loadPrompt } from '../src/prompt.js';
import { JUDGE_MODEL, JUDGE_EFFORT, PROMPT_PATH } from '../src/config.js';
import { TOOLS, toolsSha256 } from '../src/judge.js';

const p = loadPrompt();
console.log(`prompt     ${PROMPT_PATH}`);
console.log(`sha256     ${p.sha256}`);
console.log(`tools      ${TOOLS.map((t) => t.name).join(', ')}  sha256 ${toolsSha256()}`);
console.log(`model      ${JUDGE_MODEL}  effort ${JUDGE_EFFORT}`);
