'use strict';
// Migration from what came before this catalog: the `qa-ado-work-item-assistant` skill of
// the old SkillCatalog, installed by hand or by its own CLI, which never wrote a receipt.
// `engcat update` only removes what a receipt names, so without this the old skill would
// sit next to its replacements — both visible to the agent — and its state folder would
// hold the only copy of the user's PAT and contexts.
//
// Two halves, both idempotent and both reversible: nothing is deleted, every old file is
// moved aside with a timestamp, and anything already in the new layout wins over the old.
const fs = require('fs');
const path = require('path');

/**
 * Skills retired by name. Only these are moved aside; a skill directory whose name is not
 * listed here is never touched, whoever wrote it. Names the new catalog still ships
 * (grilling, safety-ssh, ...) are deliberately absent: `install` already asks before
 * overwriting a file it did not write.
 */
const RETIRED_SKILLS = ['qa-ado-work-item-assistant', 'azure-reviewer'];

/** Where each target kept a skill, relative to the install base. */
const SKILL_LOCATIONS = {
  copilot: {
    global: (n) => [`.copilot/skills/${n}`],
    // The old Copilot adapter inlined the skill into an instructions file and parked the
    // rest of the tree beside it; the instructions file is applied to every prompt.
    local: (n) => [`.github/skills/${n}`, `.github/instructions/${n}.instructions.md`, `.github/skillcatalog/${n}`],
  },
  claude: {
    global: (n) => [`.claude/skills/${n}`],
    local: (n) => [`.claude/skills/${n}`],
  },
};

const OLD_STATE = '.qa-ado-assistant';
const CREDENTIALS_STATE = '.ado-credentials';
const WORKSPACE_STATE = '.qa-ado-work-item';
const CREDENTIAL_FIELDS = ['name', 'organization', 'project'];

/**
 * Windows refuses to rename a folder while any process holds a file inside it open — an
 * agent session that loaded the skill, an editor, an indexer. Name the cause instead of
 * surfacing EPERM; nothing has been half-moved, so running again after closing is safe.
 */
function moveOrExplain(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
      throw new Error(`${from} is in use (${err.code}). Close GitHub Copilot, Claude Code and any editor or terminal open in that folder, then run the same command again.`);
    }
    throw err;
  }
}

const stampOf = (now) => now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');

/** Pure: the retired skill paths present under baseDir for these targets. */
function findRetiredSkills({ baseDir, targets, scope }) {
  const found = [];
  for (const target of targets) {
    const locations = SKILL_LOCATIONS[target];
    if (!locations) continue;
    for (const name of RETIRED_SKILLS) {
      for (const rel of locations[scope](name)) {
        if (fs.existsSync(path.join(baseDir, rel)) && !found.includes(rel)) found.push(rel);
      }
    }
  }
  return found;
}

/** Move each retired skill path under <baseDir>/.engineering-catalog/legacy/<stamp>/. */
function archiveRetiredSkills({ baseDir, targets, scope, now = new Date() }) {
  const moved = [];
  const archiveRoot = path.join('.engineering-catalog', 'legacy', stampOf(now));
  for (const rel of findRetiredSkills({ baseDir, targets, scope })) {
    const to = path.join(archiveRoot, rel);
    fs.mkdirSync(path.dirname(path.join(baseDir, to)), { recursive: true });
    moveOrExplain(path.join(baseDir, rel), path.join(baseDir, to));
    moved.push({ from: rel, to });
  }
  return moved;
}

// PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, which JSON.parse rejects.
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ConvertTo-Json on PowerShell 5.1 serialises a one-element array as a bare object.
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function copyTreeNoClobber(from, to, copied) {
  if (!fs.existsSync(from)) return;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) { copyTreeNoClobber(src, dst, copied); continue; }
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push(dst);
  }
}

/** Same wrapper setup.ps1 writes: git runs it, it runs the copy of get-pat.ps1 beside it. */
function askpassContent(getPatTarget) {
  return `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "${getPatTarget}" "%~1"\r\n`;
}

/**
 * Move the old assistant's state into the two folders that replaced it:
 *   .qa-ado-assistant\ado-pat.xml        → .ado-credentials\ado-pat.xml
 *   .qa-ado-assistant\config.json        → contexts split by field: name/organization/project
 *                                          into .ado-credentials\config.json, the rest into
 *                                          .qa-ado-work-item\config.json, joined by name
 *   .qa-ado-assistant\drafts\            → .qa-ado-work-item\drafts\
 * The PAT is DPAPI-protected for this Windows user on this machine, so a byte copy is
 * still readable by the same user. Something already in the new layout always wins: a
 * context of the same name, a PAT, a draft. The old folder is then renamed, not deleted.
 *
 * `getPatSource` is ado-credentials' get-pat.ps1; with it, the git helper pair setup.ps1
 * would write is written too, so cloning works without re-running setup.
 * Returns null when there is nothing to migrate.
 */
function migrateLegacyState({ home, getPatSource, now = new Date(), restrictAccess = () => {} }) {
  const oldRoot = path.join(home, OLD_STATE);
  if (!fs.existsSync(oldRoot)) return null;
  const credRoot = path.join(home, CREDENTIALS_STATE);
  const wsRoot = path.join(home, WORKSPACE_STATE);
  const report = { contexts: [], skipped: [], pat: 'none', drafts: 0, helper: false, archivedTo: null };

  const credRootExisted = fs.existsSync(credRoot);
  fs.mkdirSync(credRoot, { recursive: true });
  if (!credRootExisted) restrictAccess(credRoot);

  const oldPat = path.join(oldRoot, 'ado-pat.xml');
  const newPat = path.join(credRoot, 'ado-pat.xml');
  if (fs.existsSync(oldPat)) {
    if (fs.existsSync(newPat)) report.pat = 'kept-existing';
    else { fs.copyFileSync(oldPat, newPat); report.pat = 'moved'; }
  }

  const old = readJson(path.join(oldRoot, 'config.json'));
  if (old) {
    const credFile = path.join(credRoot, 'config.json');
    const wsFile = path.join(wsRoot, 'config.json');
    const cred = readJson(credFile) || { version: 1, contexts: [] };
    const ws = readJson(wsFile) || { version: 1, contexts: [] };
    cred.contexts = asArray(cred.contexts);
    ws.contexts = asArray(ws.contexts);
    for (const ctx of asArray(old.contexts)) {
      if (!ctx || !ctx.name) continue;
      const credPart = Object.fromEntries(CREDENTIAL_FIELDS.map((k) => [k, ctx[k]]));
      const wsPart = Object.fromEntries(Object.entries(ctx).filter(([k]) => k === 'name' || !CREDENTIAL_FIELDS.includes(k)));
      const hadCred = cred.contexts.some((c) => c.name === ctx.name);
      const hadWs = ws.contexts.some((c) => c.name === ctx.name);
      if (!hadCred) cred.contexts.push(credPart);
      if (!hadWs) ws.contexts.push(wsPart);
      if (hadCred && hadWs) report.skipped.push(ctx.name);
      else report.contexts.push(ctx.name);
    }
    if (!cred.activeContext && old.activeContext) cred.activeContext = old.activeContext;
    writeJson(credFile, cred);
    writeJson(wsFile, ws);
  }

  const copied = [];
  copyTreeNoClobber(path.join(oldRoot, 'drafts'), path.join(wsRoot, 'drafts'), copied);
  report.drafts = copied.length;

  if (getPatSource && fs.existsSync(getPatSource)) {
    const getPatTarget = path.join(credRoot, 'get-pat.ps1');
    const askpass = path.join(credRoot, 'git-askpass.cmd');
    if (!fs.existsSync(getPatTarget)) fs.copyFileSync(getPatSource, getPatTarget);
    if (!fs.existsSync(askpass)) fs.writeFileSync(askpass, askpassContent(getPatTarget));
    report.helper = true;
  }

  const archived = `${OLD_STATE}.migrated-${stampOf(now)}`;
  moveOrExplain(oldRoot, path.join(home, archived));
  report.archivedTo = archived;
  return report;
}

module.exports = { RETIRED_SKILLS, findRetiredSkills, archiveRetiredSkills, migrateLegacyState, askpassContent };
