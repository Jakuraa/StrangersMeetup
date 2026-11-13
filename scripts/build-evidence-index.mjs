import fs from 'node:fs';
import path from 'node:path';

const resultsFile = path.resolve('docs/launch/evidence/acceptance_results.json');
const res = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));

let md = `# NIGHTLIFEZ — Master Live Preview Evidence Index

**Target Deployment:** \`https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app\`  
**Deployment ID:** \`dpl_DoPokr69C3j3e5oPRkq51vobcoER\`  
**Git Commit SHA:** \`142cc62\`  
**Total Tests Executed:** ${res.length}  
**Audit Date:** November 10, 2026  

---

## 1. Master Evidence Table

| Test ID | Role | Target Route | Viewport | Action Performed | Expected Result | Actual Observed Outcome | Status | Screenshot Link |
|---|---|---|---|---|---|---|---|---|
`;

res.forEach(t => {
  const shot = t.screenshotPath ? `[${t.screenshotPath.split('/').pop()}](file:///Users/pradeepjakuraa/strangersmeetup/${t.screenshotPath})` : 'N/A';
  const expected = t.expected.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const actual = (t.actual || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 140);
  const action = t.action.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const status = t.status === 'PASS' ? '**PASS**' : t.status === 'FAIL' ? '❌ **FAIL**' : '🚫 **BLOCKED**';
  const rawUrl = (t.url || '').replace('https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app', '') || '/';
  const url = `\`${rawUrl}\``;
  md += `| ${t.id} | ${t.role} | ${url} | ${t.viewport} | ${action} | ${expected} | ${actual} | ${status} | ${shot} |\n`;
});

md += `\n---\n\n## 2. Screenshot Manifest (${fs.readdirSync('docs/launch/evidence').filter(f => f.endsWith('.png')).length} Captured Images)\n\n`;
const shots = fs.readdirSync('docs/launch/evidence').filter(f => f.endsWith('.png')).sort();
shots.forEach(s => {
  md += `- [\`${s}\`](file:///Users/pradeepjakuraa/strangersmeetup/docs/launch/evidence/${s})\n`;
});

fs.writeFileSync(path.resolve('docs/launch/FINAL_PREVIEW_EVIDENCE_INDEX.md'), md);
console.log('Successfully written FINAL_PREVIEW_EVIDENCE_INDEX.md');
