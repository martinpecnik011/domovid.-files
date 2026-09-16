#!/usr/bin/env node
// publish.mjs — cloud-native Domovid auto-publish, runs in GitHub Actions.
// No LLM, no MCP, no Claude Code in the loop — calls Composio directly via
// @composio/core (COMPOSIO_API_KEY secret). Ports the deterministic gather
// logic from ~/.claude/dashboard/domovid-publish-gather.mjs so the "is
// something due right now" decision is identical to the local/Jarvis version.
//
// Built 2026-09-16 (Martin: "aby sa automaticky poustovali videa aj ked
// nebude jarvis zapnuty"). See project_domovid_auto_publish_automation.md
// and project_boss_terminal.md sibling doc for the design rationale.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Composio } from '@composio/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'publish-state.json');

const REPO_RAW_BASE = 'https://raw.githubusercontent.com/martinpecnik011/domovid.-files/main';
const IG_USER_ID = '28028769526754743'; // domo_vid, see project_domovid_instagram_automation.md
const FB_PAGE_ID = '1216967761499957'; // Facebook Page "Domovid"

const SOURCES = [
  {
    name: 'september',
    backlogDir: path.join(ROOT, 'backlog/september'),
    usedDir: path.join(ROOT, 'backlog/september/used'),
    captionsFile: path.join(ROOT, 'backlog/september/Domovid_September_Batch_Captions.md'),
  },
];

// Ut 19:00 + St 19:00 + Št 12:30 Europe/Bratislava — same cadence as the local
// automation (domovid-publish-gather.mjs). JS Date#getDay(): Sun=0..Sat=6.
const SCHEDULE = [
  { weekday: 2, hour: 19, minute: 0, label: 'ut19' },
  { weekday: 3, hour: 19, minute: 0, label: 'st19' },
  { weekday: 4, hour: 12, minute: 30, label: 'stv1230' },
];

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return { lastHandledSlot: null };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Most recent schedule slot at or before `now` (Bratislava local time),
// scanning back up to 7 days — catches up if a run was missed/delayed.
function mostRecentDueSlot(now) {
  let best = null;
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    for (const slot of SCHEDULE) {
      if (day.getDay() !== slot.weekday) continue;
      const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.hour, slot.minute, 0, 0);
      if (candidate > now) continue;
      if (!best || candidate > best.dateTime) {
        best = { dateTime: candidate, label: slot.label, slotId: `${isoDate(candidate)}-${slot.label}` };
      }
    }
  }
  return best;
}

// Parse "## N. <filename>.mp4" headings without "PUBLIKOVAN" in the heading
// line, each with its IG/FB caption fenced blocks.
function findAllUnpublished(captionsText) {
  const headingRe = /^##\s+\d+\.\s+(\S+\.mp4)(.*)$/gm;
  const headings = [...captionsText.matchAll(headingRe)];
  const items = [];
  for (let i = 0; i < headings.length; i++) {
    const [, filename, rest] = headings[i];
    if (/PUBLIKOVAN/i.test(rest)) continue;
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : captionsText.length;
    const block = captionsText.slice(start, end);
    const igMatch = block.match(/\*\*IG caption:\*\*\s*```([\s\S]*?)```/);
    const fbMatch = block.match(/\*\*FB caption:\*\*\s*```([\s\S]*?)```/);
    items.push({
      filename,
      headingLine: block.split('\n')[0].trim(),
      igCaption: igMatch ? igMatch[1].trim() : null,
      fbCaption: fbMatch ? fbMatch[1].trim() : null,
    });
  }
  return items;
}

function gatherPublishStatus(now = new Date()) {
  const state = readState();
  const due = mostRecentDueSlot(now);
  const slotId = due ? due.slotId : null;
  const slotAlreadyHandled = !due || state.lastHandledSlot === slotId;

  const queue = [];
  for (const source of SOURCES) {
    let captionsText = '';
    try {
      captionsText = fs.readFileSync(source.captionsFile, 'utf8');
    } catch (_) {
      continue;
    }
    for (const item of findAllUnpublished(captionsText)) {
      queue.push({
        ...item,
        source: source.name,
        backlogDir: source.backlogDir,
        usedDir: source.usedDir,
        captionsFile: source.captionsFile,
        videoExists: fs.existsSync(path.join(source.backlogDir, item.filename)),
      });
    }
  }

  const backlogEmpty = queue.length === 0;
  const readyIndex = queue.findIndex((item) => item.videoExists);
  const nextPublishableItem = readyIndex === -1 ? null : queue[readyIndex];
  const blockedItems = readyIndex === -1 ? queue : queue.slice(0, readyIndex);

  return {
    now: now.toISOString(),
    due,
    slotId,
    slotAlreadyHandled,
    backlogEmpty,
    nextPublishableItem,
    blockedItems,
    state,
  };
}

async function publishToInstagramAndFacebook(item) {
  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  const userId = process.env.COMPOSIO_USER_ID || 'domovid';
  const videoUrl = `${REPO_RAW_BASE}/backlog/${item.source}/${encodeURIComponent(item.filename)}`;

  console.log(`Publishing ${item.filename} from ${videoUrl}`);

  const igCreate = await composio.tools.execute('INSTAGRAM_POST_IG_USER_MEDIA', {
    userId,
    arguments: {
      ig_user_id: IG_USER_ID,
      video_url: videoUrl,
      caption: item.igCaption,
      media_type: 'REELS',
      share_to_feed: true,
    },
    dangerouslySkipVersionCheck: true,
  });
  if (!igCreate.successful) throw new Error('IG create failed: ' + JSON.stringify(igCreate));
  const creationId = igCreate.data?.id || igCreate.data?.creation_id;
  if (!creationId) throw new Error('IG create returned no creation_id: ' + JSON.stringify(igCreate));

  const igPublish = await composio.tools.execute('INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH', {
    userId,
    arguments: {
      ig_user_id: IG_USER_ID,
      creation_id: creationId,
      max_wait_seconds: 180,
    },
    dangerouslySkipVersionCheck: true,
  });
  if (!igPublish.successful) throw new Error('IG publish failed: ' + JSON.stringify(igPublish));

  const fbPost = await composio.tools.execute('FACEBOOK_CREATE_VIDEO_POST', {
    userId,
    arguments: {
      page_id: FB_PAGE_ID,
      file_url: videoUrl,
      description: item.fbCaption,
      published: true,
    },
    dangerouslySkipVersionCheck: true,
  });
  if (!fbPost.successful) throw new Error('FB post failed: ' + JSON.stringify(fbPost));

  return { igCreate, igPublish, fbPost };
}

function markPublished(item, slotId, publishResult) {
  const text = fs.readFileSync(item.captionsFile, 'utf8');
  const escaped = item.headingLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const today = isoDate(new Date());
  const newHeading = `${item.headingLine} — ✅ PUBLIKOVANÉ ${today}`;
  const updated = text.replace(escaped, newHeading);
  fs.writeFileSync(item.captionsFile, updated);

  fs.mkdirSync(item.usedDir, { recursive: true });
  const from = path.join(item.backlogDir, item.filename);
  const to = path.join(item.usedDir, item.filename);
  fs.renameSync(from, to);

  const state = readState();
  state.lastHandledSlot = slotId;
  state.lastPublishedAt = new Date().toISOString();
  state.lastPublishedFile = item.filename;
  state.lastPublishResult = {
    igMediaId: publishResult.igPublish?.data?.id ?? null,
    fbPostId: publishResult.fbPost?.data?.id ?? null,
  };
  writeState(state);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
  const status = gatherPublishStatus();

  console.log(JSON.stringify({ ...status, dryRun }, null, 2));

  if (!status.due) {
    console.log('No schedule slot found in the last 7 days -- nothing to do.');
    return;
  }
  if (status.slotAlreadyHandled) {
    console.log(`Slot ${status.slotId} already handled -- nothing to do.`);
    return;
  }
  if (!status.nextPublishableItem) {
    console.log('Slot is due but no publishable item (backlog empty or video missing) -- nothing to do.');
    return;
  }

  const item = status.nextPublishableItem;
  if (dryRun) {
    console.log(`DRY RUN -- would publish "${item.filename}" for slot ${status.slotId}. Skipping real Composio calls.`);
    return;
  }

  const result = await publishToInstagramAndFacebook(item);
  markPublished(item, status.slotId, result);
  console.log('Publish succeeded:', JSON.stringify({
    igMediaId: result.igPublish?.data?.id,
    fbPostId: result.fbPost?.data?.id,
  }));
}

main().catch((err) => {
  console.error('publish.mjs failed:', err);
  process.exit(1);
});
