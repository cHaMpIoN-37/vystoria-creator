// Vystoria Creator App
//
// CHANGELOG (fixes for: "worked on my laptop/phone, mentor's device got a
// FATAL ERROR about a deprecated Gemini model and got stuck"):
//
// 1. Model Name is now OPTIONAL and free-text for any provider. The old
//    code hardcoded a default model per provider (e.g. 'gemini-3.5-flash')
//    directly in this file. Providers deprecate model IDs on their own
//    schedule and per-account — that's exactly what the mentor hit. Now,
//    leaving the field blank tells the backend to pick its own current
//    recommended default (see DEFAULT_MODELS in the backend), so that
//    decision lives in ONE place that can be updated without a frontend
//    redeploy. Paste any model ID from any provider and it's sent as-is.
//
// 2. FIXED A REAL BUG: once a generation task started, `taskId` was never
//    cleared, so Engine Config / Novel Parameters stayed permanently
//    LOCKED even after a run FAILED — there was no way back in to fix a
//    bad API key or model name short of a full reset that was itself only
//    reachable after a successful publish. `generationStarted` now only
//    reflects an active/completed run, so a failed run automatically
//    unlocks configuration for a retry.
//
// 3. The Generation Console and Home screen now show a clear, actionable
//    message when a run fails, with a direct link back into Engine Config.
//
// 4. AI Judge is no longer an opt-out checkbox — the backend always runs
//    it and auto-regenerates the whole draft once if it fails, so this
//    file no longer sends/collects a `run_evaluation` flag.
//
// 5. Publish now requires an explicit confirmation modal (from either the
//    Story Assets screen or the "The End" screen in the play-tester)
//    before it actually writes to the public catalog.
//
// 6. Each character expression tile in Story Assets now has a copy button
//    that copies that expression's art-prompt text to the clipboard, so
//    creators can paste it straight into an external image generator.
//
// 7. FIXED THE LOOPING/STUCK-NEAR-THE-END BUG: the play-tester's
//    `handleChoice` used to navigate to whatever `next_scene` a choice had
//    without checking it actually existed in the story. A dangling
//    reference (now also repaired server-side, but defended here too)
//    silently fell through to the scene lookup's `scenes[0]` fallback —
//    which looked exactly like the story mysteriously "looping back to
//    the start" instead of ending. `handleChoice` now validates the
//    target exists before navigating, and surfaces a clear dead-end error
//    otherwise instead of silently jumping back to scene 1.

import React, { useState, useEffect, useRef } from 'react';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import vystoriaLogo from './assets/logo.svg';
import {
  Cpu, BookOpen, Terminal, Scale, Image as ImageIcon, Sparkles, Loader2, Key,
  Play, CheckCircle2, AlertTriangle, RefreshCw, XCircle, MinusCircle, ChevronDown,
  ArrowLeft, Menu, ArrowRight, Save, Download, X, Wand2, FileText, RotateCcw,
  Copy, Check, Star, Globe, LogOut, PlayCircle, Palette
} from 'lucide-react';

// --- SUPABASE CONFIGURATION (Same as the player app) ---
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://yzdayexisufwkclaywxh.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6ZGF5ZXhpc3Vmd2tjbGF5d3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MDQwNTEsImV4cCI6MjA5NzM4MDA1MX0.YF58GCpBFwO6pH7QLBuG5IUMrP8rzKaKRsPRevVmHL0';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Falling back to defaults for demo purposes.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

// Reference docs are read client-side and inlined into the generation
// request; cap it here too so a huge file doesn't silently balloon the payload.
const MAX_REFERENCE_CHARS = 20000;

// Friendly labels + placeholder hints per provider for the Model Name field.
// These are purely cosmetic — the actual "what model to use if the field is
// left blank" decision is made by the backend (DEFAULT_MODELS), so that
// logic can be kept current in one place without redeploying this app.
const PROVIDER_LABELS = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  claude: 'Anthropic Claude',
  grok: 'xAI Grok',
};

const MODEL_PLACEHOLDERS = {
  gemini: 'Leave blank for the recommended default, or paste e.g. gemini-3.5-flash',
  openai: 'Leave blank for the recommended default, or paste e.g. gpt-4o',
  claude: 'Leave blank for the recommended default, or paste e.g. claude-sonnet-4-6',
  grok: 'Leave blank for the recommended default, or paste e.g. grok-2-latest',
};

// Asset art runs on its own provider + key so portrait generation can't eat
// the story engine's daily request allowance (and vice versa).
const IMAGE_PROVIDER_LABELS = {
  gemini: 'Google Gemini (images)',
  openai: 'OpenAI (images)',
};

const IMAGE_MODEL_PLACEHOLDERS = {
  gemini: 'Leave blank for gemini-2.5-flash-image',
  openai: 'Leave blank for gpt-image-1',
};

//// ---------------------------------------------------------------------------
// ART PROMPT COMPOSITION
//
// This is the SINGLE source of truth for what an image prompt looks like.
// The Copy button and the Generate button both run everything through
// composeImagePrompt(), so what lands on your clipboard is exactly what the
// engine would have sent — paste it into ChatGPT or Gemini and you get the
// same picture. The backend no longer appends anything of its own (see B27).
//
// The manifest's `base_description` deliberately covers the SUBJECT only —
// who the person is, what they're wearing. Style, format and the negative
// prompt are project-wide, so they're bolted on here instead of being
// repeated inside forty separate descriptions.
// ---------------------------------------------------------------------------

// Image models default to "cinematic" — shallow depth of field, grain, soft
// focus — unless told otherwise. Naming the failure modes is what suppresses
// them; a positive "flat 2D" instruction alone does not.
const FLAT_2D_RULES =
  'Flat 2D illustration with clean crisp line art and hard-edged cel shading, fully in ' +
  'focus from edge to edge. NOT 3D, NOT a render, NOT photorealistic, NOT a photograph, ' +
  'no CGI. No depth-of-field blur, no bokeh, no motion blur, no soft focus, no haze, no ' +
  'film grain, no noise, no lens flare, no chromatic aberration, no vignette. No text, no ' +
  'lettering, no title, no logo, no watermark, no signature, no border, no frame, no UI.';

const ASSET_FORMAT_RULES = {
  character: {
    label: 'Character portrait',
    format: 'Aspect ratio 3:4 (vertical portrait). Suggested size 1024 × 1365 px, PNG with transparency.',
    composition:
      'Upper-body portrait of ONE single figure, cropped at roughly the waist — from the ' +
      'top of the head down to the belt line only. Do NOT show the legs, hips, or feet; ' +
      'this is a "bust" character sprite, not a full-body reference.\n' +
      'Facing the viewer in a neutral relaxed pose, figure centred and scaled so the upper ' +
      'body fills most of the frame vertically, with clear margin only above the head — do ' +
      'not leave large empty space below the crop; zoom in rather than shrink the figure.\n' +
      'COMPLETELY TRANSPARENT BACKGROUND. Nothing at all behind the figure: no scenery, no ' +
      'room, no floor, no ground, no cast shadow, no drop shadow, no colour fill, no ' +
      'gradient, no backdrop, no props. Clean sharp silhouette edges, ready to cut out and ' +
      'composite over a scene.\n' +
      'One figure only — no turnaround sheet, no multiple poses, no side or back views, no ' +
      'reference grid, no colour swatches, no speech bubbles.',
  },
  background: {
    label: 'Scene background',
    format: 'Aspect ratio 16:9 (landscape). Suggested size 1920 × 1080 px.',
    composition:
      'Empty environment artwork. Wide establishing shot at roughly eye level.\n' +
      'ABSOLUTELY NO PEOPLE: no characters, no figures, no silhouettes, no crowds, no ' +
      'animals, no faces. This is an empty stage that characters are drawn on top of ' +
      'afterwards.\n' +
      'Keep the important detail in the upper two thirds and the left half of the frame. At ' +
      'runtime the bottom third is covered by the dialogue box and the right third by a ' +
      'character portrait, so those regions must stay visually quiet.',
  },
  cover: {
    label: 'Cover / key art',
    format: 'Aspect ratio 4:3 (landscape). Suggested size 1600 × 1200 px.',
    composition:
      'Poster-style key art with ONE clear focal subject placed dead centre.\n' +
      'CRITICAL SAFE ZONE: every essential element — the subject\'s face, the focal object, ' +
      'the silhouette — must sit inside a centred square occupying the middle of the frame. ' +
      'The app crops this image to tall 3:4, square 1:1 and wide 16:9 on different screens, ' +
      'so anything near the left or right edges or the extreme top or bottom WILL be cut ' +
      'off. Treat the outer margins as atmosphere only.\n' +
      'Bold readable silhouette that still works shrunk to a thumbnail. Leave the image ' +
      'completely free of lettering — the app draws the title itself, and baked-in text ' +
      'renders as garbled glyphs.',
  },
};

// Folder name in assetFiles -> rule key.
const ASSET_KIND_FOR = { characters: 'character', backgrounds: 'background', cover: 'cover' };

const composeImagePrompt = ({ subject, style, kind }) => {
  const rules = ASSET_FORMAT_RULES[kind] || ASSET_FORMAT_RULES.character;
  const blocks = [
    `SUBJECT\n${(subject || '').trim() || '(no description available — write one yourself)'}`,
  ];
  if (style && style.trim()) blocks.push(`ART STYLE\n${style.trim()}`);
  blocks.push(`FORMAT\n${rules.format}`);
  blocks.push(`COMPOSITION\n${rules.composition}`);
  blocks.push(`MUST NOT INCLUDE\n${FLAT_2D_RULES}`);
  return blocks.join('\n\n');
};

// navigator.clipboard needs a secure context, and the Android WebView can
// refuse it outright. Fall back to the old execCommand trick so the button
// isn't dead on a phone.
const copyTextToClipboard = async (text) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) { /* fall through */ }
  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(helper);
    return ok;
  } catch (err) {
    return false;
  }
};

// What the free tiers actually allow per day, so the pre-flight estimate can
// say something useful instead of an abstract number.
const PROVIDER_DAILY_HINT = {
  gemini: 20,
  openai: null,
  claude: null,
  grok: null,
};

const JUDGE_MODES = [
  { value: 'advisory', label: 'Advisory (recommended)', cost: '+1 call',
    blurb: 'Scores the draft once and records the scorecard. Never regenerates — fix specific problems with Tweak Scene instead.' },
  { value: 'off', label: 'Off', cost: '0 calls',
    blurb: 'Skip the quality gate entirely. Cheapest possible run; you can still run the judge by hand later from AI Judgement.' },
  { value: 'strict', label: 'Strict', cost: '+1, up to +N+1 on a fail',
    blurb: 'The old behaviour: a FAIL throws every chapter away and rewrites the book once. Doubles the cost of a run — only worth it on a paid key.' },
];

// Mirrors estimate_call_count() in the backend, so the number on screen before
// you press Initialize is the number the engine will actually spend.
const estimateCalls = (targetLength, judgeMode) => {
  const chapters = parseInt(String(targetLength).match(/\d+/)?.[0] || '8', 10);
  let calls = 2 + chapters + 1;              // world bible + outline + chapters + manifest
  if (judgeMode !== 'off') calls += 1;       // judge
  if (judgeMode === 'strict') calls += chapters + 1; // worst-case regeneration
  return calls;
};

// The backend hands images back as base64 so this app can push them through
// the SAME upload path as a manual file pick — one storage layout, one place
// that writes draft_assets, one set of RLS rules to reason about.
const base64ToFile = (base64, mimeType, filename) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mimeType || 'image/png' });
};

// Helper: pull a portrait URL out of a character's asset entry for a given
// expression, falling back to neutral, then to any available variant. Used
// by the PlayTestEngine to render the right face for each line.
// entry shape:
//   { neutral: { previewUrl, uploadedUrl }, angry: { previewUrl, uploadedUrl }, ... }
const pickPortraitFromEntry = (charEntry, expression) => {
  if (!charEntry) return null;
  const preferred = charEntry[expression] || charEntry.neutral;
  if (preferred?.previewUrl || preferred?.uploadedUrl) {
    return preferred.previewUrl || preferred.uploadedUrl;
  }
  // Last resort: return the first variant that has any image at all.
  for (const key of Object.keys(charEntry)) {
    const v = charEntry[key];
    if (v?.previewUrl || v?.uploadedUrl) return v.previewUrl || v.uploadedUrl;
  }
  return null;
};

// Rebuilds an asset manifest from a finished story when we're editing a
// published story whose original generation_tasks row is gone (published from
// another machine, or the draft was cleaned up). Descriptions are empty —
// the art itself is already attached, and Tweak Scene doesn't need them.
const deriveManifestFromStory = (storyJson) => {
  const speakers = {};
  const backgrounds = new Set();
  for (const scene of storyJson?.scenes || []) {
    if (scene.background) backgrounds.add(scene.background);
    for (const block of scene.sequence || []) {
      if (block.type === 'dialogue' && block.speaker) {
        speakers[block.speaker] = speakers[block.speaker] || new Set();
        speakers[block.speaker].add(block.expression || 'neutral');
      }
    }
  }
  return {
    characters: Object.entries(speakers).map(([name, exprs]) => ({
      name,
      base_description: '',
      expressions: [...exprs].sort().map(id => ({ id, note: '' })),
    })),
    backgrounds: [...backgrounds].sort().map(id => ({ id, description: '' })),
    cover: { description: '' },
  };
};

// Now takes a session: the studio is shared across devices, so every write
// has to be attributable to a real creator account (see F17).
function CreatorApp({ session, onSignOut }) {
  // Navigation
  const [currentView, setCurrentView] = useState('home'); // home, engine_config, novel_parameters, console, judgement, assets, library

  // Config States
  const [provider, setProvider] = useState('gemini');
  const [apiKey, setApiKey] = useState('');
  // Model IDs get deprecated by providers on their own schedule, and can
  // differ per-account (this is exactly what broke generation on a
  // mentor's device while working fine elsewhere with the same key —
  // different accounts had access to different model generations).
  // Defaulting this to '' means the backend decides the current
  // recommended model for the chosen provider; that logic lives in ONE
  // place (the backend) so it can be kept current without a new frontend
  // deploy. The creator can still paste any model ID they want — Gemini,
  // OpenAI, Claude, Grok, anything the key has access to.
  const [modelName, setModelName] = useState('');

  // --- Quota controls -------------------------------------------------
  // 'advisory' | 'off' | 'strict'. See JUDGE_MODES. Advisory is the default
  // because the old always-on strict behaviour silently doubled the cost of
  // every run that scored below 7.5.
  const [judgeMode, setJudgeMode] = useState('advisory');
  // Asked-for scenes per chapter. Lower = less chance of overrunning the
  // model's output-token ceiling, which is what produced most "JSON error"
  // retries (and every retry is a request off the daily allowance).
  const [scenesPerChapter, setScenesPerChapter] = useState(14);
  // Hard stop on model calls for one run. 0 = no ceiling.
  const [maxLlmCalls, setMaxLlmCalls] = useState(0);

  // --- Asset art (separate provider + key from the story engine) -------
  const [imageProvider, setImageProvider] = useState('gemini');
  const [imageApiKey, setImageApiKey] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [artStyle, setArtStyle] = useState(
    'Flat 2D cel-shaded anime illustration, crisp line art, hard-edged shading, cool desaturated palette'
  );
  // Written to stories.description on publish. The player app reads it for the
  // featured card blurb and the game-detail synopsis — every story currently
  // shows "No Desc. available" because nothing has ever written this column.
  const [storyDescription, setStoryDescription] = useState('');
  // True once the creator edits the style box by hand, so a later manifest
  // load doesn't overwrite their wording.
  const [artStyleTouched, setArtStyleTouched] = useState(false);
  const [generatingAssetKey, setGeneratingAssetKey] = useState(null);
  const [assetGenError, setAssetGenError] = useState(null);

  // --- Checkpoint / resume --------------------------------------------
  const [checkpointProgress, setCheckpointProgress] = useState(null);
  const [failureKind, setFailureKind] = useState(null);
  const [isResuming, setIsResuming] = useState(false);

  // --- Published-story editing ----------------------------------------
  // Non-null means "this session is editing an already-published story";
  // Publish becomes Re-publish and updates the existing catalog row instead
  // of inserting a second one.
  const [editingStoryId, setEditingStoryId] = useState(null);
  const [editingStoryUrl, setEditingStoryUrl] = useState(null);

  // --- Library ---------------------------------------------------------
  const [libraryTab, setLibraryTab] = useState('drafts'); // 'drafts' | 'published'
  const [publishedStories, setPublishedStories] = useState([]);
  const [featuringId, setFeaturingId] = useState(null);

  // Story Parameter States
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [genre, setGenre] = useState('Action / Dark Fantasy');
  const [targetLength, setTargetLength] = useState('8 chapters');
  const [tone, setTone] = useState('Dark, suspenseful, mysterious');
  const [idea, setIdea] = useState('');

  // Reference document (draft / outline / lore) the creator can attach
  // instead of, or alongside, the free-text idea.
  const [referenceText, setReferenceText] = useState('');
  const [referenceFileName, setReferenceFileName] = useState('');
  const [referenceError, setReferenceError] = useState('');

  // Generation Task Tracking
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [taskId, setTaskId] = useState(null);
  const [taskStatus, setTaskStatus] = useState('idle'); // idle, pending, generating, completed, failed
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState('');
  const [logs, setLogs] = useState([]);

  // Asset and Story Data States
  //
  // NEW shape for assetFiles.characters — nested by expression:
  //   assetFiles.characters = {
  //     "Amara": {
  //        neutral: { file, previewUrl, uploadedUrl },
  //        worried: { file, previewUrl, uploadedUrl },
  //        ...
  //     },
  //     "Bayo": { neutral: {...}, angry: {...} }
  //   }
  // Backgrounds and cover stay flat as before.
  const [assetFiles, setAssetFiles] = useState({ characters: {}, backgrounds: {}, cover: {} });
  const [showTestBed, setShowTestBed] = useState(false);
  const [hasTested, setHasTested] = useState(false);
  // Only true once the creator has actually reached an ending in the
  // play-tester — this is what "tested end to end" means, not just opening it.
  const [hasCompletedPlaythrough, setHasCompletedPlaythrough] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [resultJson, setResultJson] = useState(null);
  const [assetManifest, setAssetManifest] = useState(null);
  const [evaluationScorecard, setEvaluationScorecard] = useState(null);
  const [worldBible, setWorldBible] = useState(null); // needed as context for scene tweaks
  const [publishedStoryId, setPublishedStoryId] = useState(null);
  const [isEvaluating, setIsEvaluating] = useState(false);

  // Publish now goes through an explicit confirmation step instead of
  // firing immediately when the Publish button is tapped.
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);

  // Tracks which expression tile's art-prompt was just copied, so the
  // little copy icon can flash a checkmark for a moment.
  const [copiedExpr, setCopiedExpr] = useState(null);

  // Story Library state — lets a creator browse and resume past
  // generation_tasks rows instead of losing everything on refresh.
  const [myStories, setMyStories] = useState([]);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);

  // Auto-scroll log panel
  const logsEndRef = useRef(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Polling Supabase for Background Task Updates (runs regardless of which screen is open)
  //
  // Explicit column list, not select('*'). The task row now carries a
  // `checkpoint` column holding every generated chapter — pulling that down
  // every 2 seconds would be megabytes of scene JSON per minute. We read the
  // small `checkpoint_progress` summary instead.
  const TASK_POLL_COLUMNS =
    'id, status, progress_percent, current_step, logs, result_json, asset_manifest, ' +
    'evaluation_scorecard, world_bible, published_story_id, playtest_completed, ' +
    'checkpoint_progress, failure_kind, provider, title, created_at';

  useEffect(() => {
    let pollInterval;

    if (taskId && ['pending', 'generating'].includes(taskStatus)) {
      pollInterval = setInterval(async () => {
        const { data } = await supabase
          .from('generation_tasks')
          .select(TASK_POLL_COLUMNS)
          .eq('id', taskId)
          .single();

        if (data) {
          setTaskStatus(data.status);
          setProgress(data.progress_percent);
          setCurrentStep(data.current_step);
          setLogs(data.logs || []);
          setCheckpointProgress(data.checkpoint_progress || null);
          setFailureKind(data.failure_kind || null);
          if (data.result_json) setResultJson(data.result_json);
          if (data.asset_manifest) setAssetManifest(data.asset_manifest);
          if (data.evaluation_scorecard) setEvaluationScorecard(data.evaluation_scorecard);
          if (data.world_bible) setWorldBible(data.world_bible);
        }
      }, 2000);
    }

    return () => clearInterval(pollInterval);
  }, [taskId, taskStatus]);

  // A failed run is resumable when the engine banked anything worth keeping.
  // This is what turns "429 on chapter 7" from a lost day into a pause.
  const canResume = taskStatus === 'failed'
    && !!taskId
    && !!checkpointProgress?.has_world_bible;

  // The manifest now carries a synopsis and a one-line art direction. Adopt
  // both, but never clobber something the creator has already typed.
  useEffect(() => {
    if (!assetManifest) return;
    if (assetManifest.synopsis) {
      setStoryDescription(prev => prev || assetManifest.synopsis);
    }
    if (assetManifest.art_direction && !artStyleTouched) {
      setArtStyle(assetManifest.art_direction);
    }
  }, [assetManifest, artStyleTouched]);



  // --- Workflow locking -----------------------------------------------
  // Once a generation task is actively running or has finished
  // successfully, Engine Config and Novel Parameters lock: changing the
  // provider/API key or the story brief mid-run (or after a completed
  // run) would desync what's on screen from what actually produced the
  // story sitting in `resultJson`.
  //
  // A FAILED run deliberately does NOT lock these. If generation blew up
  // (e.g. the provider rejected a deprecated model name, or the API key
  // was wrong), the creator needs a way back into Engine Config to fix
  // the provider / API key / model and press Initialize Pipeline again.
  // Previously `taskId !== null` was part of this check, which meant a
  // failed run left the creator permanently locked out with no path
  // forward except a full reset that was itself only reachable after a
  // *successful* publish — a dead end.
  const generationStarted = ['pending', 'generating', 'completed'].includes(taskStatus);
  const configLocked = generationStarted;

  const resetAll = () => {
    setCurrentView('home');
    setTaskId(null);
    setTaskStatus('idle');
    setProgress(0);
    setCurrentStep('');
    setLogs([]);
    setResultJson(null);
    setAssetManifest(null);
    setEvaluationScorecard(null);
    setWorldBible(null);
    setDraftSaved(false);
    setHasCompletedPlaythrough(false);
    setHasTested(false);
    setPublishedStoryId(null);
    setAssetFiles({ characters: {}, backgrounds: {}, cover: {} });
    setReferenceText('');
    setReferenceFileName('');
    setReferenceError('');
    setCheckpointProgress(null);
    setFailureKind(null);
    setEditingStoryId(null);
    setEditingStoryUrl(null);
    setAssetGenError(null);
    setStoryDescription('');
    setArtStyleTouched(false);
  };

  // Where uploaded art lands in the bucket. Normally the task id; when
  // editing a story whose original draft row no longer exists, a stable
  // story-scoped folder so re-publishing twice doesn't scatter files.
  const assetScopeId = taskId || (editingStoryId ? `story_${editingStoryId}` : null);

  // Publishes a fresh story, OR re-publishes one already in the catalog when
  // `editingStoryId` is set (opened from Story Library → Published).
  //
  // Re-publish writes a NEW json filename every time rather than upserting
  // over the old one. The player app resolves a story by the filename it
  // derives from `stories.url` and downloads through Storage, so reusing a
  // path means readers can be served a cached copy of the previous version
  // for hours. A new name makes the swap atomic and instant.
  const handlePublish = async () => {
    if (!resultJson) return;
    setIsSavingDraft(true);

    try {
      const { data: { session: activeSession } } = await supabase.auth.getSession();
      if (!activeSession) throw new Error('Your session expired — sign in again.');
      const user = activeSession.user;

      const isEdit = !!editingStoryId;
      const slugBase = `${title}-${editingStoryId || Date.now()}`
        .toLowerCase().replace(/[^a-z0-9]+/g, '_');

      const assets = { backgrounds: {}, characters: {} };

      // Backgrounds — reuse an already-uploaded URL, otherwise upload fresh.
      for (const [bgId, entry] of Object.entries(assetFiles.backgrounds)) {
        let url = entry.uploadedUrl;
        if (!url && entry.file) {
          const ext = entry.file.name.split('.').pop();
          const path = `assets/${slugBase}/backgrounds/${bgId}.${ext}`;
          const { error } = await supabase.storage.from('visual-novels').upload(path, entry.file, { upsert: true });
          if (error) throw new Error(`Background upload failed (${bgId}): ${error.message}`);
          url = supabase.storage.from('visual-novels').getPublicUrl(path).data.publicUrl;
        }
        if (url) assets.backgrounds[bgId] = url;
      }

      // Characters — nested {charName: {expr: entry}}.
      for (const [charName, expressionMap] of Object.entries(assetFiles.characters)) {
        if (!expressionMap || typeof expressionMap !== 'object') continue;
        assets.characters[charName] = {};
        for (const [expr, entry] of Object.entries(expressionMap)) {
          if (!entry) continue;
          let url = entry.uploadedUrl;
          if (!url && entry.file) {
            const ext = entry.file.name.split('.').pop();
            const safeName = charName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            const safeExpr = expr.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            const path = `assets/${slugBase}/characters/${safeName}_${safeExpr}.${ext}`;
            const { error } = await supabase.storage.from('visual-novels').upload(path, entry.file, { upsert: true });
            if (error) throw new Error(`Character upload failed (${charName}/${expr}): ${error.message}`);
            url = supabase.storage.from('visual-novels').getPublicUrl(path).data.publicUrl;
          }
          if (url) assets.characters[charName][expr] = url;
        }
        if (Object.keys(assets.characters[charName]).length === 0) {
          delete assets.characters[charName];
        }
      }

      // Cover.
      let coverUrl = assetFiles.cover.cover?.uploadedUrl || null;
      if (!coverUrl && assetFiles.cover.cover?.file) {
        const ext = assetFiles.cover.cover.file.name.split('.').pop();
        const path = `assets/${slugBase}/cover_${Date.now()}.${ext}`;
        const { error } = await supabase.storage.from('visual-novels').upload(path, assetFiles.cover.cover.file, { upsert: true });
        if (error) throw new Error(`Cover upload failed: ${error.message}`);
        coverUrl = supabase.storage.from('visual-novels').getPublicUrl(path).data.publicUrl;
      }

      // Story JSON — new object name on every publish (see the note above).
      const jsonPath = `${slugBase}_v${Date.now()}.json`;
      const jsonBlob = new Blob([JSON.stringify(resultJson)], { type: 'application/json' });
      const { error: jsonErr } = await supabase.storage.from('visual-novels').upload(jsonPath, jsonBlob, { upsert: true });
      if (jsonErr) throw new Error(`Story JSON upload failed: ${jsonErr.message}`);
      const storyUrl = supabase.storage.from('visual-novels').getPublicUrl(jsonPath).data.publicUrl;

      let storyRow;
      if (isEdit) {
        const { data, error: updateErr } = await supabase
          .from('stories')
          .update({
            title: `${title}${subtitle ? `: ${subtitle}` : ''}`,
            subtitle: subtitle || null,
            description: storyDescription.trim() || null,
            url: storyUrl,
            genre,
            assets,
            ...(coverUrl ? { cover_image: coverUrl } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingStoryId)
          .select()
          .single();
        if (updateErr) throw new Error(`Catalog update failed: ${updateErr.message}`);
        storyRow = data;

        // Retire the previous JSON object so the bucket doesn't accumulate a
        // version per edit. Best-effort: a failure here is cosmetic.
        if (editingStoryUrl) {
          const oldPath = editingStoryUrl.substring(editingStoryUrl.lastIndexOf('/') + 1);
          if (oldPath && oldPath !== jsonPath) {
            supabase.storage.from('visual-novels').remove([oldPath]).catch(() => {});
          }
        }
        setEditingStoryUrl(storyUrl);
      } else {
        const { data, error: insertErr } = await supabase
          .from('stories')
          .insert({
            title: `${title}: ${subtitle}`,
            subtitle: subtitle || null,
            description: storyDescription.trim() || null,
            url: storyUrl,
            genre,
            creator_id: user?.id,
            assets,
            cover_image: coverUrl,
          })
          .select()
          .single();
        if (insertErr) throw new Error(`Catalog insert failed: ${insertErr.message}`);
        storyRow = data;
      }

      if (taskId) {
        await supabase
          .from('generation_tasks')
          .update({ published_story_id: storyRow.id, status: 'published' })
          .eq('id', taskId);
      }

      setPublishedStoryId(storyRow.id);
      setEditingStoryId(storyRow.id);
      setDraftSaved(true);
      setLogs(prev => [...prev,
        isEdit
          ? `✅ Re-published! "${title}" updated in the live catalog (stories.id=${storyRow.id}).`
          : `✅ Published! "${title}" is now live at stories.id=${storyRow.id}`
      ]);
    } catch (err) {
      setLogs(prev => [...prev, `[Error] Publish failed: ${err.message}`]);
      alert(`Publish failed: ${err.message}`);
    } finally {
      setIsSavingDraft(false);
    }
  };

  // Atomic swap via RPC — `stories.is_featured` carries a partial unique
  // index, so clearing the old winner and setting the new one has to happen
  // in one transaction or the second UPDATE gets rejected.
  const handleSetFeatured = async (storyId, makeFeatured) => {
    setFeaturingId(storyId);
    try {
      const { error } = makeFeatured
        ? await supabase.rpc('set_featured_story', { p_story_id: storyId })
        : await supabase.rpc('clear_featured_story', { p_story_id: storyId });
      if (error) throw error;
      setPublishedStories(prev => prev.map(s => ({
        ...s,
        is_featured: makeFeatured ? s.id === storyId : (s.id === storyId ? false : s.is_featured),
      })));
    } catch (err) {
      alert(`Could not update the featured story: ${err.message}`);
    } finally {
      setFeaturingId(null);
    }
  };

  const handleRunEvaluation = async () => {
    if (!taskId || !apiKey) return;
    setIsEvaluating(true);
    try {
      const response = await fetch(`${BACKEND_URL}/evaluate/${taskId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey, model_name: modelName.trim() })
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status} ${response.statusText}`;
        try {
          const errBody = await response.json();
          if (errBody?.detail) detail = errBody.detail;
        } catch (parseErr) {}
        throw new Error(detail);
      }
      const result = await response.json();
      if (result.evaluation_scorecard) setEvaluationScorecard(result.evaluation_scorecard);
      setLogs(prev => [...prev, `[System] AI Judge re-run complete: ${result.evaluation_scorecard?.status || 'unknown'}.`]);
    } catch (err) {
      setLogs(prev => [...prev, `[Error] AI evaluation failed: ${err.message}`]);
    } finally {
      setIsEvaluating(false);
    }
  };

  // Hot-swap a single revised scene into resultJson after a tweak.
  const handleSceneUpdate = (updatedScene) => {
    setResultJson(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        scenes: prev.scenes.map(s => (s.id === updatedScene.id ? updatedScene : s)),
      };
    });
    setLogs(prev => [...prev, `🪄 Scene "${updatedScene.id}" was rewritten per your instruction.`]);
  };

  // Persists that the creator reached a real ending, so Publish stays
  // unlocked across a refresh.
  const handleCompletePlaythrough = async () => {
    setHasCompletedPlaythrough(true);
    if (taskId) {
      try {
        await supabase.from('generation_tasks').update({ playtest_completed: true }).eq('id', taskId);
      } catch (err) {
        console.error('Failed to persist playtest completion:', err);
      }
    }
  };

  // Loads every generation_tasks row belonging to the signed-in creator,
  // newest first, for the Story Library screen.
  // Loads EVERY studio draft, not just the signed-in creator's.
  //
  // This is the change that makes the studio shared. The old query filtered
  // `.eq('creator_id', user.id)`, so a story generated on one phone was
  // invisible on another — the database was already common, the query wasn't.
  // RLS (see the migration) is what actually enforces "studio members only".
  const fetchMyStories = async () => {
    setIsLoadingLibrary(true);
    try {
      const { data, error } = await supabase
        .from('generation_tasks')
        .select('id, title, provider, status, progress_percent, current_step, ' +
                'published_story_id, created_at, creator_id, checkpoint_progress, failure_kind')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      setMyStories(data || []);
    } catch (err) {
      console.error('Failed to load story library:', err);
      setMyStories([]);
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  // The published catalog — the same rows the player app reads.
  const fetchPublishedStories = async () => {
    setIsLoadingLibrary(true);
    try {
      const { data, error } = await supabase
        .from('stories')
        .select('id, title, subtitle, description, genre, url, cover_image, assets, is_featured, creator_id, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      setPublishedStories(data || []);
    } catch (err) {
      console.error('Failed to load published stories:', err);
      setPublishedStories([]);
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  const openLibrary = (tab = 'drafts') => {
    setLibraryTab(tab);
    if (tab === 'published') fetchPublishedStories(); else fetchMyStories();
    setCurrentView('library');
  };

  // Fully rehydrates CreatorApp's state from a past generation_tasks row so
  // the creator can pick up exactly where they left off — including
  // previously-uploaded assets and playtest/publish status.
  // Flat rehydrate (backgrounds, cover): {key: url} → {key: {previewUrl, uploadedUrl}}
  const flatAssetEntries = (obj) => Object.fromEntries(
    Object.entries(obj || {}).map(([k, url]) => [k, { file: null, previewUrl: url, uploadedUrl: url }])
  );

  // Nested rehydrate for characters. Supports BOTH stored shapes:
  //   Old:  { "Amara": "https://..." }                         (single portrait)
  //   New:  { "Amara": { "neutral": "...", "angry": "..." } }  (per-expression)
  const nestedCharAssetEntries = (obj) => {
    const out = {};
    for (const [name, val] of Object.entries(obj || {})) {
      if (typeof val === 'string') {
        out[name] = { neutral: { file: null, previewUrl: val, uploadedUrl: val } };
      } else if (val && typeof val === 'object') {
        out[name] = {};
        for (const [expr, url] of Object.entries(val)) {
          if (typeof url === 'string') {
            out[name][expr] = { file: null, previewUrl: url, uploadedUrl: url };
          }
        }
      }
    }
    return out;
  };

  // Fully rehydrates CreatorApp's state from a generation_tasks row so the
  // creator can pick up exactly where they left off — including
  // previously-uploaded assets, playtest/publish status, and any checkpoint
  // left behind by a quota-interrupted run.
  const hydrateFromTaskRow = (data) => {
    setTaskId(data.id);
    setTaskStatus(data.status);
    setProgress(data.progress_percent || 0);
    setCurrentStep(data.current_step || '');
    setLogs(data.logs || []);
    setResultJson(data.result_json || null);
    setAssetManifest(data.asset_manifest || null);
    setEvaluationScorecard(data.evaluation_scorecard || null);
    setWorldBible(data.world_bible || null);
    setPublishedStoryId(data.published_story_id || null);
    setDraftSaved(!!data.published_story_id);
    setHasCompletedPlaythrough(!!data.playtest_completed);
    setProvider(data.provider || 'gemini');
    setCheckpointProgress(data.checkpoint_progress || null);
    setFailureKind(data.failure_kind || null);

    const [t, ...rest] = (data.title || '').split(':');
    setTitle((t || '').trim());
    setSubtitle(rest.join(':').trim());

    const draft = data.draft_assets || {};
    setAssetFiles({
      characters: nestedCharAssetEntries(draft.characters),
      backgrounds: flatAssetEntries(draft.backgrounds),
      cover: flatAssetEntries(draft.cover),
    });
  };

  const resumeTask = async (task) => {
    const { data, error } = await supabase.from('generation_tasks').select('*').eq('id', task.id).single();
    if (error) { alert(`Could not resume: ${error.message}`); return; }

    hydrateFromTaskRow(data);
    setEditingStoryId(null);
    setEditingStoryUrl(null);
    setCurrentView(['pending', 'generating'].includes(data.status) ? 'console' : 'home');
  };

  // Opens an ALREADY-PUBLISHED story for editing — scene tweaks, asset swaps,
  // then Re-publish over the same catalog row.
  //
  // Preferred path is the originating generation_tasks row, because it still
  // holds the world bible (needed by Tweak Scene) and the asset manifest with
  // its art descriptions. If that row is gone, we fall back to downloading the
  // published JSON and deriving a bare manifest from the scenes themselves.
  const openPublishedStory = async (story) => {
    setIsLoadingLibrary(true);
    try {
      const { data: taskRow } = await supabase
        .from('generation_tasks')
        .select('*')
        .eq('published_story_id', story.id)
        .maybeSingle();

      if (taskRow) {
        hydrateFromTaskRow(taskRow);
      } else {
        const res = await fetch(story.url);
        if (!res.ok) throw new Error(`Could not download the published story JSON (HTTP ${res.status}).`);
        const storyJson = await res.json();

        setTaskId(null);
        setTaskStatus('completed');
        setProgress(100);
        setCurrentStep('Editing a published story');
        setLogs([`[System] Loaded published story ${story.id} for editing (no draft row found).`]);
        setResultJson(storyJson);
        setAssetManifest(deriveManifestFromStory(storyJson));
        setEvaluationScorecard(null);
        setWorldBible(null);
        setCheckpointProgress(null);
        setFailureKind(null);

        const [t, ...rest] = (story.title || '').split(':');
        setTitle((t || '').trim());
        setSubtitle(rest.join(':').trim());
        setAssetFiles({
          characters: nestedCharAssetEntries(story.assets?.characters),
          backgrounds: flatAssetEntries(story.assets?.backgrounds),
          cover: story.cover_image
            ? { cover: { file: null, previewUrl: story.cover_image, uploadedUrl: story.cover_image } }
            : {},
        });
      }

      setGenre(story.genre || 'Uncategorized');
      setStoryDescription(story.description || '');
      setPublishedStoryId(story.id);
      setEditingStoryId(story.id);
      setEditingStoryUrl(story.url);
      setDraftSaved(true);
      // Already live and already play-tested once — don't force a second
      // full playthrough before an edit can go back out.
      setHasCompletedPlaythrough(true);
      setCurrentView('assets');
    } catch (err) {
      alert(`Could not open that story for editing: ${err.message}`);
    } finally {
      setIsLoadingLibrary(false);
    }
  };



  const handleReferenceFile = async (file) => {
    if (!file) return;
    setReferenceError('');
    try {
      const text = await file.text();
      if (!text.trim()) {
        setReferenceError('That file appears to be empty.');
        return;
      }
      setReferenceText(text.slice(0, MAX_REFERENCE_CHARS));
      setReferenceFileName(file.name);
    } catch (err) {
      setReferenceError(`Could not read that file: ${err.message}`);
    }
  };

  const handleGenerate = async () => {
    if (!apiKey || !title || !subtitle) {
      alert("Please provide an API Key, Title, and Subtitle.");
      return;
    }

    // Clear out anything left over from a previous (possibly failed)
    // attempt so the UI can never show a stale scene, scorecard, asset
    // manifest, or task id from a run that no longer represents what's on
    // screen. Clearing taskId in particular stops the background poller
    // from briefly re-attaching to the OLD (failed) task row while this
    // new request is in flight.
    setTaskId(null);
    setIsSubmitting(true);
    setTaskStatus('pending');
    setLogs([
      `[System] Sending configuration to the Vystoria Engine — ` +
      `~${estimateCalls(targetLength, judgeMode)} model calls budgeted for this run.`
    ]);
    setProgress(0);
    setCurrentStep('');
    setEvaluationScorecard(null);
    setResultJson(null);
    setAssetManifest(null);
    setWorldBible(null);
    setPublishedStoryId(null);
    setDraftSaved(false);
    setHasCompletedPlaythrough(false);
    setHasTested(false);
    setCheckpointProgress(null);
    setFailureKind(null);
    setEditingStoryId(null);
    setEditingStoryUrl(null);

    try {
      // The anonymous-sign-in fallback is gone on purpose. Each anonymous
      // session is a brand-new auth.users row, so a story generated on your
      // phone belonged to a *different* user than one generated on your
      // mentor's — which is precisely why the library never lined up across
      // devices. A shared studio needs a shared, real identity.
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (!user || userError) {
        throw new Error('Your session expired. Sign out and back in, then try again.');
      }
      const userId = user.id;

      const response = await fetch(`${BACKEND_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          api_key: apiKey,
          model_name: modelName.trim(),
          title,
          subtitle,
          genre,
          target_length: targetLength,
          tone,
          idea: idea.trim() || null,
          reference_text: referenceText.trim() || null,
          user_id: userId,
          // Quota controls — see Engine Config.
          judge_mode: judgeMode,
          scenes_per_chapter: Number(scenesPerChapter) || 14,
          max_llm_calls: Number(maxLlmCalls) || 0,
        })
      });

      if (!response.ok) {
        let detail = `HTTP ${response.status} ${response.statusText}`;
        try {
          const errBody = await response.json();
          if (errBody?.detail) detail = errBody.detail;
        } catch (parseErr) {}
        throw new Error(`Backend rejected the request: ${detail}`);
      }

      const result = await response.json();
      setTaskId(result.task_id);
      setLogs(prev => [...prev, `[System] Engine handshake accepted. Provider authenticated.`]);

    } catch (err) {
      setTaskStatus('failed');
      const isNetworkError = err instanceof TypeError;
      const message = isNetworkError
        ? `Could not reach the backend at ${BACKEND_URL}. Is the FastAPI server running? (${err.message})`
        : err.message;
      setLogs(prev => [...prev, `[Error] ${message}`]);
    } finally {
      setIsSubmitting(false);
    }
  };


  // Picks a quota-interrupted run back up from its checkpoint. Chapters
  // already written cost nothing to restore — only what's left gets paid for.
  // The provider/key can be different from the original run, which is how a
  // Gemini run that hit the daily wall gets finished on an OpenAI key.
  const handleResumeGeneration = async () => {
    if (!taskId || !apiKey) {
      alert('Set an API key in Engine Config first.');
      return;
    }
    setIsResuming(true);
    try {
      const response = await fetch(`${BACKEND_URL}/resume/${taskId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          api_key: apiKey,
          model_name: modelName.trim(),
          judge_mode: judgeMode,
          scenes_per_chapter: Number(scenesPerChapter) || 14,
          max_llm_calls: Number(maxLlmCalls) || 0,
        }),
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status} ${response.statusText}`;
        try {
          const errBody = await response.json();
          if (errBody?.detail) detail = errBody.detail;
        } catch (parseErr) { /* keep the status line */ }
        throw new Error(detail);
      }
      const result = await response.json();
      setTaskStatus('pending');
      setFailureKind(null);
      setLogs(prev => [...prev,
        `[System] Resuming — ${result.chapters_restored} chapter(s) restored free, ` +
        `${result.chapters_remaining} left to write.`]);
      setCurrentView('console');
    } catch (err) {
      setLogs(prev => [...prev, `[Error] Resume failed: ${err.message}`]);
      alert(`Resume failed: ${err.message}`);
    } finally {
      setIsResuming(false);
    }
  };

  // Generates one asset from its own description and pushes the result
  // through the SAME upload path a manual file pick uses, so storage layout,
  // draft_assets bookkeeping and RLS all stay in one place.
  const handleGenerateAsset = async (kind, key, promptText, expression = null) => {
    const tileKey = expression ? `${key}__${expression}` : `${kind}__${key}`;

    if (!imageApiKey) {
      setAssetGenError('No image API key set. Engine Config → Asset Art.');
      return;
    }
    if (!promptText || !promptText.trim()) {
      setAssetGenError(`No description exists for "${key}" — upload art manually, or re-run the asset manifest.`);
      return;
    }
    if (!assetScopeId) {
      setAssetGenError('Nothing to attach this art to yet — generate or open a story first.');
      return;
    }

    setGeneratingAssetKey(tileKey);
    setAssetGenError(null);
    try {
      const assetKind = ASSET_KIND_FOR[kind] || 'character';
      const response = await fetch(`${BACKEND_URL}/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: imageProvider,
          api_key: imageApiKey,
          model_name: imageModel.trim() || null,
          // Fully composed here, and `compose: false` tells the backend to
          // send it through untouched. That guarantees Copy and Generate are
          // byte-identical — otherwise the two paths drift the first time
          // either side's wording is edited.
          prompt: composeImagePrompt({ subject: promptText, style: artStyle, kind: assetKind }),
          kind: assetKind,
          style: null,
          compose: false,
        }),
      });

      if (!response.ok) {
        let detail = `HTTP ${response.status} ${response.statusText}`;
        try {
          const errBody = await response.json();
          if (errBody?.detail) detail = errBody.detail;
        } catch (parseErr) { /* keep the status line */ }
        throw new Error(detail);
      }

      const result = await response.json();
      const ext = (result.mime_type || 'image/png').split('/')[1] || 'png';
      const safeKey = `${key}${expression ? `_${expression}` : ''}`
        .toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const file = base64ToFile(result.image_base64, result.mime_type, `${safeKey}.${ext}`);

      await handleAssetFileChange(kind, key, file, expression);
      setLogs(prev => [...prev, `🎨 Generated art for ${key}${expression ? ` (${expression})` : ''}.`]);
    } catch (err) {
      setAssetGenError(`${key}${expression ? ` (${expression})` : ''}: ${err.message}`);
    } finally {
      setGeneratingAssetKey(null);
    }
  };

  const handleProviderChange = (e) => {
    const newProvider = e.target.value;
    setProvider(newProvider);
    // A model name that was valid for the old provider almost certainly
    // isn't valid for the new one — clear it instead of guessing a
    // hardcoded default here. Leaving it blank lets the backend apply its
    // own (centrally-updatable) recommended default for whichever
    // provider ends up selected.
    setModelName('');
  };

  // Uploads art the moment it's picked (instead of waiting for Publish), and
  // records the resulting public URL onto the task row's draft_assets column
  // so a refresh mid-upload doesn't lose it.
  //
  // For characters, `expression` is required and the state / storage are
  // nested by (character name, expression). For backgrounds and cover,
  // expression stays null and the state is flat.
  const handleAssetFileChange = async (kind, key, file, expression = null) => {
    // assetScopeId, not taskId: editing a published story whose draft row was
    // cleaned up still needs somewhere stable to put the art.
    if (!file || !assetScopeId) return;

    const previewUrl = URL.createObjectURL(file);
    const isCharWithExpr = kind === 'characters' && !!expression;

    // Optimistic local update, respecting nesting for characters.
    setAssetFiles(prev => {
      if (!isCharWithExpr) {
        return { ...prev, [kind]: { ...prev[kind], [key]: { file, previewUrl, uploading: true } } };
      }
      const existingChar = prev.characters[key] || {};
      return {
        ...prev,
        characters: {
          ...prev.characters,
          [key]: { ...existingChar, [expression]: { file, previewUrl, uploading: true } }
        }
      };
    });

    try {
      const safeKey = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const ext = file.name.split('.').pop();
      const suffix = isCharWithExpr ? `_${expression.toLowerCase().replace(/[^a-z0-9]+/g, '_')}` : '';
      const path = `assets/${assetScopeId}/${kind}/${safeKey}${suffix}_${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('visual-novels').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const publicUrl = supabase.storage.from('visual-novels').getPublicUrl(path).data.publicUrl;

      // Commit the uploaded URL to local state (nested for characters).
      setAssetFiles(prev => {
        if (!isCharWithExpr) {
          return { ...prev, [kind]: { ...prev[kind], [key]: { file, previewUrl, uploadedUrl: publicUrl } } };
        }
        const existingChar = prev.characters[key] || {};
        return {
          ...prev,
          characters: {
            ...prev.characters,
            [key]: { ...existingChar, [expression]: { file, previewUrl, uploadedUrl: publicUrl } }
          }
        };
      });

      // Persist to draft_assets on the task row (nested for characters,
      // flat for backgrounds/cover — same as the state shape). Skipped when
      // there's no draft row, e.g. editing a published story directly; in
      // that case Re-publish is what commits the new asset map.
      if (taskId) {
        const { data: row } = await supabase.from('generation_tasks').select('draft_assets').eq('id', taskId).single();
        const draft = row?.draft_assets || {};
        if (isCharWithExpr) {
          draft.characters = draft.characters || {};
          // If a prior draft accidentally stored a flat string for this char
          // (old-shape leftovers), promote it into the new nested object under
          // "neutral" so we don't lose that upload when we merge in the new one.
          if (typeof draft.characters[key] === 'string') {
            draft.characters[key] = { neutral: draft.characters[key] };
          }
          draft.characters[key] = { ...(draft.characters[key] || {}), [expression]: publicUrl };
        } else {
          draft[kind] = { ...(draft[kind] || {}), [key]: publicUrl };
        }
        await supabase.from('generation_tasks').update({ draft_assets: draft }).eq('id', taskId);
      }
    } catch (err) {
      console.error('Asset upload failed:', err);
      setLogs(prev => [...prev, `[Error] Failed to upload ${kind} "${key}"${isCharWithExpr ? '/' + expression : ''}: ${err.message}`]);
    }
  };

  // Copies a COMPLETE, self-contained art prompt — subject, house style,
  // aspect ratio, composition rules and negative prompt. Paste it into
  // ChatGPT, Gemini, Midjourney or anything else and you get the same image
  // the Generate button would have produced, because both call the same
  // composer.
  const handleCopyAssetPrompt = async (kind, key, subject, expressionId = null) => {
    const text = composeImagePrompt({
      subject,
      style: artStyle,
      kind: ASSET_KIND_FOR[kind] || 'character',
    });
    const tileKey = expressionId ? `${key}__${expressionId}` : `${kind}__${key}`;
    const ok = await copyTextToClipboard(text);
    if (!ok) {
      setAssetGenError('Could not reach the clipboard. Open the tile and select the text by hand.');
      return;
    }
    setCopiedExpr(tileKey);
    setTimeout(() => setCopiedExpr(prev => (prev === tileKey ? null : prev)), 1500);
  };

  // Kept as a thin wrapper so CharacterAssetCard's existing call signature
  // (character, expr) doesn't have to change.
  const handleCopyExpressionPrompt = (character, expr) => {
    const subject = [character.base_description || character.description, expr.note]
      .filter(Boolean)
      .join(' — ');
    return handleCopyAssetPrompt('characters', character.name, subject, expr.id);
  };

  //  // A simple flat row used for backgrounds and cover art. Characters get
  // their own richer component (CharacterAssetCard) below because they now
  // have per-expression upload slots.
  //
  // Each row now offers Generate (AI) alongside Upload, using the same
  // description text the Copy button hands to an external tool.
  const AssetRow = ({ id, description, preview, onFile, onGenerate, isGenerating,
                      canGenerate, onCopy, justCopied }) => {
    const [showModal, setShowModal] = useState(false);
    return (
      <>
        <div
          className="bg-[#1C1635] border border-transparent rounded-2xl p-4 flex items-center gap-4 hover:border-[#8B5CF6]/30 transition-all shadow-sm cursor-pointer"
          onClick={() => setShowModal(true)}
        >
          <div className="w-14 h-14 rounded-xl bg-[#0B0B14] overflow-hidden flex-shrink-0 flex items-center justify-center border border-[#2D1B4E]">
            {isGenerating
              ? <Loader2 className="w-5 h-5 text-[#A78BFA] animate-spin" />
              : preview
                ? <img src={preview} className="w-full h-full object-cover" alt={id} />
                : <ImageIcon className="w-5 h-5 text-[#4D3A7A]" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-base font-bold truncate tracking-wide">{id}</p>
            <p className="text-[#8A7DAB] text-[13px] leading-snug line-clamp-2 mt-1">{description || 'No description generated.'}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              onClick={onCopy}
              title="Copy the full art prompt — style, aspect ratio and all — ready to paste anywhere"
              className={`border text-xs font-bold px-3 py-2.5 rounded-xl transition-colors flex items-center gap-2 ${
                justCopied
                  ? 'bg-[#10B981] border-[#10B981] text-white'
                  : 'bg-transparent border-[#4D3A7A] hover:border-[#8B5CF6] text-[#C4B5FD] hover:bg-[#2D1B4E]'
              }`}
            >
              {justCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={onGenerate}
              disabled={!canGenerate || isGenerating || !description}
              title={!canGenerate ? 'Add an image API key in Engine Config → Asset Art' : 'Generate this asset with AI'}
              className="bg-[#2D1B4E] hover:bg-[#3B0764] disabled:opacity-40 disabled:cursor-not-allowed border border-[#8B5CF6]/40 text-[#C4B5FD] text-xs font-bold px-3 py-2.5 rounded-xl transition-colors flex items-center gap-2"
            >
              {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">Generate</span>
            </button>
            <label className="bg-transparent hover:bg-[#2D1B4E] border border-[#4D3A7A] hover:border-[#8B5CF6] text-white text-xs font-bold px-3 py-2.5 rounded-xl cursor-pointer transition-colors shadow-sm flex items-center gap-2">
              <span className="hidden sm:inline">Upload</span>
              <UploadCloudIcon className="w-3.5 h-3.5" />
              <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
          </div>
        </div>

        {showModal && (
          <div className="fixed inset-0 z-[999] bg-black/80 flex items-center justify-center p-6 backdrop-blur-sm" onClick={() => setShowModal(false)}>
            <div className="bg-[#120F24] border border-[#2D1B4E] rounded-3xl p-6 max-w-lg w-full shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-white text-xl font-bold">{id}</h3>
                <button onClick={() => setShowModal(false)} className="w-8 h-8 bg-[#1C1635] rounded-full flex items-center justify-center hover:bg-[#2D1B4E] transition-colors"><X className="text-[#8A7DAB] w-4 h-4" /></button>
              </div>
              <div className="bg-[#0B0B14] border border-[#1C1635] rounded-xl p-4 mb-6 max-h-56 overflow-y-auto">
                 <p className="text-[#C4B5FD] text-[15px] leading-relaxed select-all whitespace-pre-line">{description || 'No description generated.'}</p>
              </div>
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={onCopy}
                  className={`w-full font-bold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2 border ${
                    justCopied
                      ? 'bg-[#10B981] border-[#10B981] text-white'
                      : 'bg-transparent border-[#4D3A7A] hover:border-[#8B5CF6] hover:bg-[#1C1635] text-white'
                  }`}
                >
                  {justCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {justCopied ? 'Copied full prompt' : 'Copy full art prompt'}
                </button>
                <button
                  type="button"
                  onClick={() => { onGenerate(); setShowModal(false); }}
                  disabled={!canGenerate || isGenerating || !description}
                  className="w-full bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:bg-[#2D1B4E] disabled:text-[#8A7DAB] disabled:cursor-not-allowed text-white font-bold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  <Sparkles className="w-4 h-4" /> Generate with AI
                </button>
                <label className="w-full bg-transparent border border-[#4D3A7A] hover:border-[#8B5CF6] hover:bg-[#1C1635] text-white font-bold py-3.5 rounded-xl cursor-pointer transition-colors flex items-center justify-center gap-2">
                  <UploadCloudIcon className="w-4 h-4" /> Upload Art
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); setShowModal(false); }} />
                </label>
              </div>
            </div>
          </div>
        )}
      </>
    );
  };


  //   // Per-character asset card: one row per character, with a grid of slots —
  // one slot per expression the story actually uses. The character's shared
  // base description shows once at the top; each expression tile carries TWO
  // small buttons: copy the art prompt for an external tool, or generate it
  // right here on the Asset Art key.
  const CharacterAssetCard = ({
    character, uploadedByExpr, onUpload, onCopyPrompt, copiedKey,
    onGenerate, generatingKey, canGenerate,
  }) => {
    const expressions = character.expressions?.length
      ? character.expressions
      : [{ id: 'neutral', note: '' }];

    const baseDescription = character.base_description || character.description || '';

    return (
      <div className="bg-[#1C1635] border border-[#2D1B4E] rounded-2xl p-4">
        <div className="mb-4">
          <p className="text-white font-bold text-base tracking-wide">{character.name}</p>
          <p className="text-[#8A7DAB] text-[13px] leading-snug mt-1">
            {baseDescription || 'No description generated.'}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {expressions.map(expr => {
            const entry = uploadedByExpr?.[expr.id];
            const preview = entry?.previewUrl || entry?.uploadedUrl;
            const tileKey = `${character.name}__${expr.id}`;
            const justCopied = copiedKey === tileKey;
            const isGenerating = generatingKey === tileKey;
            return (
              <div key={expr.id} className="relative">
                <label
                  className="relative aspect-square bg-[#0B0B14] border border-[#2D1B4E] rounded-lg overflow-hidden cursor-pointer hover:border-[#8B5CF6]/60 transition-colors group block"
                  title={expr.note || expr.id}
                >
                  {isGenerating ? (
                    <div className="w-full h-full flex items-center justify-center bg-[#120F24]">
                      <Loader2 className="w-5 h-5 text-[#A78BFA] animate-spin" />
                    </div>
                  ) : preview ? (
                    <img src={preview} alt={`${character.name} - ${expr.id}`} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1 px-2 text-center">
                      <ImageIcon className="w-4 h-4 text-[#4D3A7A] group-hover:text-[#8B5CF6] transition-colors" />
                      {expr.note && (
                        <span className="text-[9px] text-[#4D3A7A] leading-tight line-clamp-2">{expr.note}</span>
                      )}
                    </div>
                  )}
                  <div className="absolute bottom-0 inset-x-0 bg-black/75 backdrop-blur-sm text-white text-[9px] py-1 text-center font-bold tracking-widest uppercase">
                    {expr.id}
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onUpload(expr.id, e.target.files?.[0])}
                  />
                </label>

                <div className="absolute top-1 right-1 flex items-center gap-1 z-10">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      onGenerate(character, expr);
                    }}
                    disabled={!canGenerate || isGenerating || !baseDescription}
                    title={
                      !canGenerate ? 'Add an image API key in Engine Config → Asset Art'
                        : !baseDescription ? 'No description to draw from'
                        : 'Generate this portrait with AI'
                    }
                    className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors ${
                      !canGenerate || !baseDescription
                        ? 'bg-black/50 text-[#4D3A7A] cursor-not-allowed'
                        : 'bg-black/70 text-[#C4B5FD] hover:bg-[#8B5CF6] hover:text-white'
                    }`}
                  >
                    {isGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCopyPrompt(character, expr); }}
                    title="Copy the full art prompt — style, aspect ratio, transparent background and all"
                    className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors ${
                      justCopied ? 'bg-[#10B981] text-white' : 'bg-black/70 text-[#C4B5FD] hover:bg-[#8B5CF6] hover:text-white'
                    }`}
                  >
                    {justCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };



  const UploadCloudIcon = ({className}) => (
     <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path>
        <path d="M12 12v9"></path>
        <path d="m16 16-4-4-4 4"></path>
      </svg>
  );

  const STATUS_META = {
    idle:       { label: 'Idle', dot: 'bg-[#4D3A7A]', text: 'text-[#8A7DAB]' },
    pending:    { label: 'Starting', dot: 'bg-[#8B5CF6] animate-pulse', text: 'text-[#C4B5FD]' },
    generating: { label: 'Generating', dot: 'bg-[#8B5CF6] animate-pulse', text: 'text-[#C4B5FD]' },
    completed:  { label: 'Completed', dot: 'bg-[#10B981]', text: 'text-[#34D399]' },
    draft_saved:{ label: 'Draft Saved', dot: 'bg-[#10B981]', text: 'text-[#34D399]' },
    failed:     { label: 'Error', dot: 'bg-[#EF4444]', text: 'text-[#FCA5A5]' },
  };
  const status = STATUS_META[taskStatus] || STATUS_META.idle;

  const ScreenHeader = ({ title: heading, subtitleText, right }) => (
    <div className="flex flex-col mb-8 pt-2">
      <div className="flex items-center gap-4">
        <button onClick={() => setCurrentView('home')} className="w-12 h-12 bg-transparent border border-[#2D1B4E] rounded-full flex items-center justify-center hover:bg-[#1C1635] transition flex-shrink-0">
          <ArrowLeft className="text-[#A78BFA] w-6 h-6" />
        </button>
        <div className="flex-1">
           <h2 className="text-[28px] font-serif font-bold text-white tracking-wide">{heading}</h2>
           {subtitleText && <p className="text-[#8A7DAB] text-sm mt-0.5">{subtitleText}</p>}
        </div>
        {right}
      </div>
    </div>
  );

  const NavPill = ({ icon: Icon, label, description, onClick, disabled, trailing, disabledLabel = "Generate first" }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center justify-between rounded-3xl p-5 transition-all duration-300 border ${
        disabled
            ? 'bg-[#120F24] border-transparent opacity-60 cursor-not-allowed'
            : 'bg-[#1C1635] border-[#2D1B4E] hover:border-[#8B5CF6]/50 hover:bg-[#211B3D] active:scale-[0.98]'
      }`}
    >
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-full border border-[#4D3A7A] bg-[#0B0B14] flex items-center justify-center flex-shrink-0 shadow-inner">
          <Icon className={`w-5 h-5 ${disabled ? 'text-[#4D3A7A]' : 'text-[#A78BFA]'}`} strokeWidth={2} />
        </div>
        <div className="flex flex-col items-start">
            <span className="text-white font-bold text-lg tracking-wide">{label}</span>
            <span className="text-[#8A7DAB] text-[13px] font-medium mt-0.5 text-left">{description}</span>
        </div>
      </div>

      {disabled ? (
        <span className="text-[10px] text-[#4D3A7A] font-bold uppercase tracking-widest mr-2">{disabledLabel}</span>
      ) : trailing}
    </button>
  );

  const FieldLabel = ({ children }) => (
    <label className="text-[13px] font-bold text-[#A78BFA] uppercase tracking-widest mb-2.5 block">{children}</label>
  );

  const fieldClasses = "w-full bg-[#1C1635] border border-[#2D1B4E] rounded-2xl p-4 text-[15px] text-white focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6] transition-all placeholder:text-[#4D3A7A]";

  // --- Screens ---

  const renderHome = () => {
    const estimated = estimateCalls(targetLength, judgeMode);
    const dailyHint = PROVIDER_DAILY_HINT[provider];
    const overBudget = dailyHint != null && estimated > dailyHint;

    return (
      <div className="flex flex-col h-full bg-[#0B0B14]">
        <div className="flex-1 overflow-y-auto px-8 pt-14 pb-6 flex flex-col items-center">
          <div className="w-21 h-21 mb-4 flex items-center justify-center">
            <img src={vystoriaLogo} alt="Vystoria Org Logo" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-4xl font-bold font-sans tracking-wide text-white mb-1">Vystoria</h1>
          <p className="text-lg text-purple-300 font-sans tracking-wide mb-4">Story Engine</p>

          <div className="flex items-center gap-2.5 bg-[#120F24] border border-[#2D1B4E] rounded-full px-4 py-2 mb-4 shadow-inner">
            <span className={`w-2.5 h-2.5 rounded-full ${status.dot}`}></span>
            <span className={`text-xs font-bold uppercase tracking-wider ${status.text}`}>{status.label}</span>
          </div>

          {/* Pre-flight cost. The whole reason runs kept dying at 429 was that
              nothing ever said what a run costs against a 20/day allowance. */}
          {!generationStarted && (
            <div className={`w-full max-w-md mb-5 rounded-2xl p-4 border text-[12px] leading-relaxed ${
              overBudget
                ? 'bg-[#422006]/30 border-[#EAB308]/40 text-[#FDE047]'
                : 'bg-[#120F24] border-[#2D1B4E] text-[#8A7DAB]'
            }`}>
              <div className="flex items-center gap-2 mb-1">
                {overBudget ? <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> : <Cpu className="w-3.5 h-3.5 flex-shrink-0" />}
                <span className="font-bold uppercase tracking-widest text-[11px]">
                  Estimated cost: ~{estimated} model calls
                </span>
              </div>
              {overBudget ? (
                <span>
                  {PROVIDER_LABELS[provider]}'s free tier allows about {dailyHint} requests/day — this run
                  won't fit. Drop to fewer chapters, set Judge to Off, or use a paid key.
                </span>
              ) : (
                <span>
                  {targetLength} · judge: {judgeMode} · {scenesPerChapter} scenes/chapter.
                  {dailyHint != null && ` Free-tier ceiling is about ${dailyHint} requests/day.`}
                </span>
              )}
            </div>
          )}

          {taskStatus === 'failed' && (
            <div className="w-full max-w-md mb-5 bg-[#3B0764]/20 border border-[#EF4444]/40 rounded-2xl p-4">
              <p className="text-[#FCA5A5] text-[12px] font-semibold leading-relaxed mb-3">
                {failureKind === 'quota'
                  ? 'Paused: the provider cut this key off. Nothing is lost — everything written so far is checkpointed.'
                  : failureKind === 'model'
                    ? 'The provider rejected that model name. Open Engine Config and change it.'
                    : 'Last attempt failed — see the Generation Console for details. Engine Config is unlocked.'}
              </p>
              {canResume && (
                <>
                  <p className="text-[#C4B5FD] text-[11px] leading-relaxed mb-3">
                    Checkpoint holds {checkpointProgress?.chapters_done ?? 0}/{checkpointProgress?.num_chapters ?? '?'} chapters
                    {checkpointProgress?.scenes_banked ? ` (${checkpointProgress.scenes_banked} scenes)` : ''}.
                    Resuming only pays for what's left.
                  </p>
                  <button
                    onClick={handleResumeGeneration}
                    disabled={isResuming || !apiKey}
                    className="w-full bg-gradient-to-r from-[#9333EA] to-[#7C3AED] hover:from-[#A855F7] hover:to-[#8B5CF6] disabled:opacity-50 text-white font-bold py-3 rounded-xl text-[14px] transition-all flex items-center justify-center gap-2"
                  >
                    {isResuming ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                    {isResuming ? 'Resuming...' : 'Resume From Checkpoint'}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="w-full space-y-4 max-w-md mx-auto">
            <NavPill
              icon={Cpu}
              label="Engine Config"
              description={`${provider}${modelName.trim() ? ' · ' + modelName.trim().split('-')[0] : ' · auto-selected model'} · judge: ${judgeMode}`}
              onClick={() => setCurrentView('engine_config')}
              disabled={configLocked}
              disabledLabel="Locked after start"
            />
            <NavPill
              icon={BookOpen}
              label="Novel Parameters"
              description={title ? `${title}` : 'Untitled draft'}
              onClick={() => setCurrentView('novel_parameters')}
              disabled={configLocked}
              disabledLabel="Locked after start"
            />
            <NavPill
              icon={Terminal}
              label="Generation Console"
              description={status.label}
              onClick={() => setCurrentView('console')}
              trailing={<span className={`w-3 h-3 rounded-full ${status.dot} mr-2`} />}
            />
            <NavPill
              icon={Scale}
              label="AI Judgement"
              description="Quality scorecard"
              onClick={() => setCurrentView('judgement')}
              disabled={!resultJson}
            />
            <NavPill
              icon={ImageIcon}
              label="Story Assets"
              description={editingStoryId ? 'Editing a published story' : 'Art, play-test & save'}
              onClick={() => setCurrentView('assets')}
              disabled={!resultJson}
            />
            <NavPill
              icon={FileText}
              label="Story Library"
              description="Studio drafts & the live catalog"
              onClick={() => openLibrary('drafts')}
            />
          </div>

          <button
            onClick={onSignOut}
            className="mt-6 text-[#4D3A7A] hover:text-[#8A7DAB] text-[11px] font-bold uppercase tracking-widest flex items-center gap-2 transition-colors"
          >
            <LogOut className="w-3 h-3" /> {session?.user?.email || 'Sign out'}
          </button>
        </div>

        <div className="px-6 pb-8 pt-4 bg-gradient-to-t from-[#0B0B14] via-[#0B0B14] to-transparent flex-shrink-0 z-10 max-w-md mx-auto w-full">
          <button
            onClick={() => { handleGenerate(); setCurrentView('console'); }}
            disabled={isSubmitting || generationStarted}
            className="w-full bg-gradient-to-r from-[#9333EA] to-[#7C3AED] hover:from-[#A855F7] hover:to-[#8B5CF6] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-[18px] text-[17px] rounded-full shadow-[0_0_30px_rgba(139,92,246,0.4)] transition-all flex items-center justify-center gap-3 transform hover:scale-[1.02] active:scale-[0.98]"
          >
            {['pending', 'generating'].includes(taskStatus) ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
            {['pending', 'generating'].includes(taskStatus) ? 'Engine Running...' : generationStarted ? 'Pipeline Already Run' : 'Initialize Pipeline'}
          </button>

          {(hasCompletedPlaythrough && draftSaved) || taskStatus === 'failed' ? (
            <button
              onClick={resetAll}
              className="w-full mt-3 bg-transparent border border-[#3B0764] hover:bg-[#1C1635] text-[#A78BFA] font-bold py-4 rounded-full text-[15px] transition-all flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-4 h-4" /> {taskStatus === 'failed' ? 'Discard & Start Fresh' : 'Start New Story'}
            </button>
          ) : null}
        </div>
      </div>
    );
  };



  const renderEngineConfig = () => {
    const activeJudge = JUDGE_MODES.find(m => m.value === judgeMode) || JUDGE_MODES[0];
    return (
      <div className="flex flex-col h-full bg-[#0B0B14]">
        <div className="flex-1 overflow-y-auto px-6 pt-12 pb-6 max-w-md mx-auto w-full">
          <ScreenHeader title="Engine Config" subtitleText="Paste any provider's API key — the engine works with whatever model that key currently has access to." />

          <div className="space-y-6 mt-8">
            <div>
              <FieldLabel>Provider</FieldLabel>
              <select value={provider} onChange={handleProviderChange} className={fieldClasses}>
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI (ChatGPT)</option>
                <option value="claude">Anthropic Claude</option>
                <option value="grok">xAI Grok</option>
              </select>
            </div>

            <div>
              <FieldLabel>
                Model Name <span className="text-[#8A7DAB] normal-case tracking-normal text-xs ml-1">(optional)</span>
              </FieldLabel>
              <input
                type="text"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder={MODEL_PLACEHOLDERS[provider] || 'Leave blank for the recommended default'}
                className={fieldClasses}
              />
              <p className="text-xs text-[#8A7DAB] mt-3 leading-relaxed pl-1">
                Leave this blank and the engine will use its current recommended model for {PROVIDER_LABELS[provider] || 'this provider'}.
                Or paste any model ID your key has access to.
              </p>
            </div>

            <div>
              <FieldLabel><span className="flex items-center gap-2"><Key className="w-4 h-4" /> Secret API Key</span></FieldLabel>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={`Enter ${provider} API Key`} className={fieldClasses} />
              <p className="text-xs text-[#8A7DAB] mt-3 leading-relaxed pl-1">Stored only in this session — never written to the story catalog.</p>
            </div>

            {/* ---------- QUOTA CONTROLS ---------- */}
            <div className="pt-2">
              <div className="inline-flex items-center gap-2 bg-[#1C1635] px-4 py-2 rounded-full mb-4">
                <h4 className="text-[#A78BFA] font-bold text-xs tracking-widest uppercase">Quota Controls</h4>
              </div>
              <p className="text-[11px] text-[#4D3A7A] italic mb-5 pl-1 leading-relaxed">
                A run costs roughly <span className="text-[#8A7DAB] not-italic font-bold">chapters + 4</span> model
                calls. Gemini's free tier allows about 20 requests per day, so an 8-chapter book with a
                strict judge cannot fit in one day on a free key.
              </p>

              <div className="space-y-6">
                <div>
                  <FieldLabel>AI Quality Judge</FieldLabel>
                  <select value={judgeMode} onChange={(e) => setJudgeMode(e.target.value)} className={fieldClasses}>
                    {JUDGE_MODES.map(m => (
                      <option key={m.value} value={m.value}>{m.label} — {m.cost}</option>
                    ))}
                  </select>
                  <p className="text-xs text-[#8A7DAB] mt-3 leading-relaxed pl-1">{activeJudge.blurb}</p>
                </div>

                <div>
                  <FieldLabel>Scenes Per Chapter</FieldLabel>
                  <select value={scenesPerChapter} onChange={(e) => setScenesPerChapter(Number(e.target.value))} className={fieldClasses}>
                    <option value={10}>10 — tight, most reliable</option>
                    <option value={14}>14 — balanced (recommended)</option>
                    <option value={18}>18 — long chapters</option>
                    <option value={24}>24 — very long (may overrun output limits)</option>
                  </select>
                  <p className="text-xs text-[#8A7DAB] mt-3 leading-relaxed pl-1">
                    Long chapters overrun the model's output-token ceiling and come back as truncated JSON,
                    which costs a retry — and every retry is a request off your daily allowance.
                  </p>
                </div>

                <div>
                  <FieldLabel>
                    Max Model Calls <span className="text-[#8A7DAB] normal-case tracking-normal text-xs ml-1">(0 = no limit)</span>
                  </FieldLabel>
                  <input
                    type="number"
                    min={0}
                    value={maxLlmCalls}
                    onChange={(e) => setMaxLlmCalls(e.target.value)}
                    placeholder="e.g. 16"
                    className={fieldClasses}
                  />
                  <p className="text-xs text-[#8A7DAB] mt-3 leading-relaxed pl-1">
                    A hard stop, checked before every call. Set it a little under your daily allowance
                    (e.g. 16 against Gemini's 20) and you'll get a clean, checkpointed pause from Vystoria
                    instead of a raw 429 from the vendor.
                  </p>
                </div>
              </div>
            </div>

            {/* ---------- ASSET ART ---------- */}
            <div className="pt-2">
              <div className="inline-flex items-center gap-2 bg-[#1C1635] px-4 py-2 rounded-full mb-4">
                <Palette className="w-3.5 h-3.5 text-[#A78BFA]" />
                <h4 className="text-[#A78BFA] font-bold text-xs tracking-widest uppercase">Asset Art</h4>
              </div>
              <p className="text-[11px] text-[#4D3A7A] italic mb-5 pl-1 leading-relaxed">
                A separate provider and key, on purpose: write the story on one account, draw forty
                portraits on another, and neither eats the other's daily allowance.
              </p>

              <div className="space-y-6">
                <div>
                  <FieldLabel>Image Provider</FieldLabel>
                  <select value={imageProvider} onChange={(e) => { setImageProvider(e.target.value); setImageModel(''); }} className={fieldClasses}>
                    <option value="gemini">Google Gemini (images)</option>
                    <option value="openai">OpenAI (images)</option>
                  </select>
                </div>

                <div>
                  <FieldLabel>
                    Image Model <span className="text-[#8A7DAB] normal-case tracking-normal text-xs ml-1">(optional)</span>
                  </FieldLabel>
                  <input
                    type="text"
                    value={imageModel}
                    onChange={(e) => setImageModel(e.target.value)}
                    placeholder={IMAGE_MODEL_PLACEHOLDERS[imageProvider]}
                    className={fieldClasses}
                  />
                </div>

                <div>
                  <FieldLabel><span className="flex items-center gap-2"><Key className="w-4 h-4" /> Image API Key</span></FieldLabel>
                  <input
                    type="password"
                    value={imageApiKey}
                    onChange={(e) => setImageApiKey(e.target.value)}
                    placeholder={`Enter ${IMAGE_PROVIDER_LABELS[imageProvider] || 'image'} key`}
                    className={fieldClasses}
                  />
                </div>

                <div>
                  <FieldLabel>House Art Style</FieldLabel>
                  <textarea
                    value={artStyle}
                    onChange={(e) => { setArtStyle(e.target.value); setArtStyleTouched(true); }}
                    rows={3}
                    placeholder="e.g. Moody painterly anime key art, cool desaturated palette, dramatic rim lighting"
                    className={`${fieldClasses} resize-none`}
                  />
                  <p className="text-xs text-[#8A7DAB] mt-3 leading-relaxed pl-1">
                    Prepended to every generated asset so thirty portraits and fifteen backgrounds come
                    back looking like one game rather than thirty-five unrelated images.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 pb-8 pt-4 flex-shrink-0 max-w-md mx-auto w-full">
          <button onClick={() => setCurrentView('home')} className="w-full bg-[#1C1635] hover:bg-[#2D1B4E] border border-[#3B0764] text-white font-bold py-[18px] text-[17px] rounded-full shadow-lg transition-all">Done</button>
        </div>
      </div>
    );
  };

  const renderNovelParameters = () => (
    <div className="flex flex-col h-full bg-[#0B0B14]">
      <div className="flex-1 overflow-y-auto px-6 pt-12 pb-6 max-w-md mx-auto w-full">
        <ScreenHeader title="Novel Parameters" subtitleText="Define the core elements of your story." />
        <div className="space-y-6 mt-8">
          <div>
            <FieldLabel>Title</FieldLabel>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. The Amethyst Hour" className={fieldClasses} />
          </div>
          <div>
            <FieldLabel>Subtitle</FieldLabel>
            <input type="text" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="e.g. Chapter 1: The Frozen City" className={fieldClasses} />
          </div>
          <div>
            <FieldLabel>Genre Tags</FieldLabel>
            <input type="text" value={genre} onChange={(e) => setGenre(e.target.value)} className={fieldClasses} />
          </div>
          <div>
            <FieldLabel>Target Chapters</FieldLabel>
            <select value={targetLength} onChange={(e) => setTargetLength(e.target.value)} className={fieldClasses}>
              <option value="3 chapters">3 Chapters (Short)</option>
              <option value="5 chapters">5 Chapters (Medium)</option>
              <option value="8 chapters">8 Chapters (Full)</option>
              <option value="12 chapters">12 Chapters (Epic)</option>
            </select>
          </div>
          <div>
            <FieldLabel>Tone / Atmosphere</FieldLabel>
            <input type="text" value={tone} onChange={(e) => setTone(e.target.value)} className={fieldClasses} />
          </div>
          <div>
             <FieldLabel>
              Your Idea / Concept <span className="text-[#8A7DAB] normal-case tracking-normal text-xs ml-1">(optional)</span>
            </FieldLabel>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              rows={4}
              placeholder="e.g. 'She wakes up with no memory in a city where everyone can read minds except her.'"
              className={`${fieldClasses} resize-none`}
            />
          </div>

          <div>
            <FieldLabel>
              Reference Story Doc <span className="text-[#8A7DAB] normal-case tracking-normal text-xs ml-1">(optional — .txt or .md)</span>
            </FieldLabel>
            {referenceFileName ? (
              <div className="flex items-center justify-between bg-[#120F24] border border-[#2D1B4E] rounded-2xl p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-4 h-4 text-[#A78BFA] flex-shrink-0" />
                  <span className="text-[13px] text-[#C4B5FD] truncate">{referenceFileName}</span>
                  <span className="text-[11px] text-[#4D3A7A] flex-shrink-0">{referenceText.length.toLocaleString()} chars</span>
                </div>
                <button
                  onClick={() => { setReferenceText(''); setReferenceFileName(''); setReferenceError(''); }}
                  className="text-[#8A7DAB] hover:text-white text-xs font-bold flex-shrink-0 ml-3"
                >
                  Remove
                </button>
              </div>
            ) : (
              <label className={`${fieldClasses} flex items-center justify-center gap-2 cursor-pointer text-[#8A7DAB] text-[14px] hover:border-[#8B5CF6] transition-colors`}>
                <FileText className="w-4 h-4" /> Upload draft / outline / lore doc
                <input
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  className="hidden"
                  onChange={(e) => handleReferenceFile(e.target.files?.[0])}
                />
              </label>
            )}
            {referenceError && <p className="text-xs text-[#FCA5A5] mt-2">{referenceError}</p>}
            <p className="text-xs text-[#8A7DAB] mt-3 leading-relaxed pl-1">
              If attached, the engine adapts this document into the World Bible instead of inventing a fresh plot from the idea field above.
            </p>
          </div>

          <div className="flex items-start gap-4 bg-[#120F24] border border-[#2D1B4E] rounded-2xl p-5 mt-4">
            <div className="pt-0.5">
              <Scale className="w-5 h-5 text-[#A78BFA]" />
            </div>
            <div className="flex-1">
              <span className="text-[15px] font-bold text-white block mb-1">
                AI Quality Judge — {judgeMode}
              </span>
              <span className="text-[13px] text-[#8A7DAB] block leading-relaxed">
                {judgeMode === 'strict'
                  ? 'A FAIL throws every chapter away and rewrites the book once. That roughly doubles the cost of the run — switch to Advisory in Engine Config if you are on a free key.'
                  : judgeMode === 'off'
                    ? 'Skipped during generation. You can still score the finished draft by hand from the AI Judgement screen.'
                    : 'Scores the draft once and records the scorecard. It never triggers a rewrite — fix specific problems with Tweak Scene, which costs one call instead of a whole book.'}
              </span>
              <span className="text-[12px] text-[#4D3A7A] block mt-2">
                This run: ~{estimateCalls(targetLength, judgeMode)} model calls.
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="px-6 pb-8 pt-4 flex-shrink-0 max-w-md mx-auto w-full">
        <button onClick={() => setCurrentView('home')} className="w-full bg-[#1C1635] hover:bg-[#2D1B4E] border border-[#3B0764] text-white font-bold py-[18px] text-[17px] rounded-full shadow-lg transition-all">Done</button>
      </div>
    </div>
  );

  const renderConsole = () => (
    <div className="flex flex-col h-full bg-[#0B0B14]">
      <div className="px-6 pt-12 flex-shrink-0 max-w-md mx-auto w-full">
        <ScreenHeader
          title="Generation Console"
          subtitleText="Live output from the story engine."
          right={
            <button onClick={async () => {
              const { data } = await supabase.from('generation_tasks').select('*').eq('id', taskId).single();
              if (data?.result_json) setResultJson(data.result_json);
              if (data?.asset_manifest) setAssetManifest(data.asset_manifest);
              if (data?.evaluation_scorecard) setEvaluationScorecard(data.evaluation_scorecard);
              if (data?.world_bible) setWorldBible(data.world_bible);
            }} className="w-12 h-12 bg-transparent border border-[#2D1B4E] rounded-full flex items-center justify-center hover:bg-[#1C1635] transition flex-shrink-0" title="Check for result">
              <RefreshCw className="w-5 h-5 text-[#A78BFA]" />
            </button>
          }
        />
      </div>

      {['pending', 'generating', 'completed'].includes(taskStatus) && (
        <div className="mx-6 mb-6 bg-[#120F24] border border-[#2D1B4E] rounded-2xl p-5 flex-shrink-0 max-w-md w-[calc(100%-48px)] sm:mx-auto">
          <div className="flex justify-between text-[13px] font-bold text-[#A78BFA] mb-3 uppercase tracking-widest">
            <span className="truncate pr-4">{currentStep || 'Initializing...'}</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2.5 w-full bg-[#0B0B14] rounded-full overflow-hidden border border-[#1C1635] shadow-inner">
            <div className="h-full bg-gradient-to-r from-[#7C3AED] to-[#A855F7] shadow-[0_0_12px_rgba(168,85,247,0.8)] transition-all duration-500 ease-out" style={{ width: `${progress}%` }}></div>
          </div>
        </div>
      )}

      {taskStatus === 'failed' && (
        <div className="mx-6 mb-6 bg-[#3B0764]/20 border border-[#EF4444]/50 rounded-2xl p-5 flex-shrink-0 max-w-md w-[calc(100%-48px)] sm:mx-auto flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-[#FCA5A5] flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[#FCA5A5] font-bold text-[14px] mb-1 leading-snug">{currentStep || 'Generation failed'}</p>
            <p className="text-[#C4B5FD] text-[12px] leading-relaxed mb-3">
              Engine Config and Novel Parameters are unlocked. Adjust the provider, API key, or model name, then come back and hit
              Initialize Pipeline again.
            </p>
            <button
              onClick={() => setCurrentView('engine_config')}
              className="bg-[#2D1B4E] hover:bg-[#3B0764] text-white text-[12px] font-bold px-4 py-2.5 rounded-xl transition-colors"
            >
              Open Engine Config
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 pb-8 font-mono text-[13px] leading-relaxed space-y-3 max-w-md mx-auto w-full">
        {logs.length === 0 ? (
          <div className="text-[#4D3A7A] h-full flex flex-col items-center justify-center italic text-center gap-4 px-4 pb-20">
            <Terminal className="w-10 h-10 opacity-50" strokeWidth={1.5} />
            <span className="font-sans text-[15px]">Awaiting initialization command...</span>
          </div>
        ) : (
          logs.map((log, i) => {
            const isError = log.includes('[Error]');
            const isSuccess = log.includes('✅') || log.includes('Success');
            return (
              <div key={i} className="flex gap-4 bg-[#120F24] border border-[#1C1635] rounded-xl px-4 py-3.5 shadow-sm">
                <span className="text-[#A78BFA] select-none font-bold">[{String(i + 1).padStart(3, '0')}]</span>
                <span className={`${isError ? 'text-[#FCA5A5]' : isSuccess ? 'text-[#34D399]' : 'text-[#D8B4FE]'}`}>
                  {log}
                </span>
              </div>
            );
          })
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );

  const renderLibrary = () => (
    <div className="flex flex-col h-full bg-[#0B0B14]">
      <div className="flex-1 overflow-y-auto px-6 pt-12 pb-6 max-w-md mx-auto w-full">
        <ScreenHeader
          title="Story Library"
          subtitleText="Everything the studio has made — on every device."
          right={
            <button
              onClick={() => (libraryTab === 'drafts' ? fetchMyStories() : fetchPublishedStories())}
              className="w-12 h-12 bg-transparent border border-[#2D1B4E] rounded-full flex items-center justify-center hover:bg-[#1C1635] transition flex-shrink-0"
              title="Refresh"
            >
              <RefreshCw className="w-5 h-5 text-[#A78BFA]" />
            </button>
          }
        />

        {/* Tabs */}
        <div className="flex gap-2 bg-[#120F24] border border-[#2D1B4E] rounded-2xl p-1.5 mb-6">
          {[
            { key: 'drafts', label: 'Drafts', icon: FileText },
            { key: 'published', label: 'Published', icon: Globe },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => { setLibraryTab(tab.key); tab.key === 'drafts' ? fetchMyStories() : fetchPublishedStories(); }}
              className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-[13px] font-bold transition-all ${
                libraryTab === tab.key
                  ? 'bg-[#2D1B4E] text-white shadow-inner'
                  : 'bg-transparent text-[#8A7DAB] hover:text-[#C4B5FD]'
              }`}
            >
              <tab.icon className="w-4 h-4" /> {tab.label}
            </button>
          ))}
        </div>

        {isLoadingLibrary ? (
          <div className="text-center py-20"><Loader2 className="w-6 h-6 animate-spin mx-auto text-[#8B5CF6]" /></div>
        ) : libraryTab === 'drafts' ? (
          myStories.length === 0 ? (
            <div className="text-center text-[#4D3A7A] text-[15px] py-20 italic">No drafts in the studio yet.</div>
          ) : (
            <div className="space-y-3">
              {myStories.map(t => {
                const mine = t.creator_id === session?.user?.id;
                const resumable = t.status === 'failed' && (t.checkpoint_progress?.chapters_done ?? 0) > 0;
                return (
                  <button
                    key={t.id}
                    onClick={() => resumeTask(t)}
                    className="w-full text-left bg-[#1C1635] border border-[#2D1B4E] rounded-2xl p-4 hover:border-[#8B5CF6]/50 transition-all"
                  >
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="text-white font-bold truncate">{t.title || 'Untitled'}</span>
                      <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full flex-shrink-0 ${
                        t.published_story_id ? 'bg-[#10B981]/20 text-[#34D399]'
                          : t.status === 'failed' ? 'bg-[#EF4444]/20 text-[#FCA5A5]'
                          : 'bg-[#2D1B4E] text-[#A78BFA]'
                      }`}>
                        {t.published_story_id ? 'Published' : t.status}
                      </span>
                    </div>
                    <p className="text-[#8A7DAB] text-xs truncate">
                      {t.provider} · {t.current_step || '—'} · {t.progress_percent ?? 0}%
                    </p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {!mine && (
                        <span className="text-[10px] font-bold uppercase tracking-widest text-[#4D3A7A] bg-[#0B0B14] px-2 py-1 rounded-full">
                          Teammate's
                        </span>
                      )}
                      {resumable && (
                        <span className="text-[10px] font-bold uppercase tracking-widest text-[#FDE047] bg-[#422006]/40 px-2 py-1 rounded-full">
                          Resumable · {t.checkpoint_progress.chapters_done}/{t.checkpoint_progress.num_chapters} ch
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )
        ) : publishedStories.length === 0 ? (
          <div className="text-center text-[#4D3A7A] text-[15px] py-20 italic">Nothing published yet.</div>
        ) : (
          <div className="space-y-3">
            {publishedStories.map(s => (
              <div key={s.id} className="bg-[#1C1635] border border-[#2D1B4E] rounded-2xl p-4">
                <div className="flex items-start gap-3">
                  <div className="w-14 h-20 rounded-xl bg-[#0B0B14] overflow-hidden flex-shrink-0 flex items-center justify-center border border-[#2D1B4E]">
                    {s.cover_image
                      ? <img src={s.cover_image} alt={s.title} className="w-full h-full object-cover" />
                      : <ImageIcon className="w-5 h-5 text-[#4D3A7A]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {s.is_featured && <Star className="w-3.5 h-3.5 text-[#FDE047] fill-[#FDE047] flex-shrink-0" />}
                      <span className="text-white font-bold truncate">{s.title || 'Untitled'}</span>
                    </div>
                    <p className="text-[#8A7DAB] text-xs truncate">{s.genre || 'Uncategorized'}</p>
                    <p className="text-[#4D3A7A] text-[11px] mt-1">
                      Updated {new Date(s.updated_at || s.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2 mt-4">
                  <button
                    onClick={() => openPublishedStory(s)}
                    className="flex-1 bg-[#2D1B4E] hover:bg-[#3B0764] border border-[#4D3A7A] text-white text-[13px] font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    <Wand2 className="w-4 h-4" /> Edit
                  </button>
                  <button
                    onClick={() => handleSetFeatured(s.id, !s.is_featured)}
                    disabled={featuringId === s.id}
                    title={s.is_featured ? 'Remove from the home page hero' : 'Make this the home page hero'}
                    className={`flex-1 text-[13px] font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 border disabled:opacity-50 ${
                      s.is_featured
                        ? 'bg-[#FDE047]/15 border-[#EAB308]/50 text-[#FDE047] hover:bg-[#FDE047]/25'
                        : 'bg-transparent border-[#4D3A7A] text-[#8A7DAB] hover:border-[#EAB308]/60 hover:text-[#FDE047]'
                    }`}
                  >
                    {featuringId === s.id
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <Star className={`w-4 h-4 ${s.is_featured ? 'fill-[#FDE047]' : ''}`} />}
                    {s.is_featured ? 'Featured' : 'Feature'}
                  </button>
                </div>
              </div>
            ))}
            <p className="text-[11px] text-[#4D3A7A] italic leading-relaxed pt-2 pl-1">
              Only one story can be featured at a time — featuring a new one automatically un-features
              the current hero.
            </p>
          </div>
        )}
      </div>
    </div>
  );

  const renderJudgement = () => (
    <div className="flex flex-col h-full bg-[#0B0B14]">
      <div className="flex-1 overflow-y-auto px-6 pt-12 pb-8 max-w-md mx-auto w-full">
        <ScreenHeader title="AI Judgement" subtitleText="An automated quality review of your draft." />
        {!resultJson ? (
          <div className="text-center text-[#4D3A7A] text-[15px] py-20 italic">Generate a story first.</div>
        ) : (
          <JudgeScorecard
            scorecard={evaluationScorecard}
            isEvaluating={isEvaluating}
            onRerun={handleRunEvaluation}
            canRerun={!!apiKey && !!taskId}
          />
        )}
      </div>
    </div>
  );

  const renderAssets = () => {
    // Computed once so the Copy button, the Generate button and the row's
    // visible text can never disagree about what the cover is meant to be.
    const coverDescription = assetManifest?.cover?.description
      || `Poster-style key art for "${title}" — ${genre}, ${tone}.`;

    return (
    <div className="flex flex-col h-full bg-[#0B0B14]">
      <div className="flex-1 overflow-y-auto px-6 pt-12 pb-6 max-w-md mx-auto w-full">
        <ScreenHeader title="Story Assets" subtitleText="Attach art, play-test end to end, then save." />

        {!resultJson ? (
          <div className="text-center text-[#4D3A7A] text-[15px] py-20 italic">Generate a story first.</div>
        ) : (
          <div className="space-y-8">
            {editingStoryId && (
              <div className="bg-[#2D1B4E]/40 border border-[#8B5CF6]/40 rounded-2xl p-5 text-[#C4B5FD] text-[13px] leading-relaxed flex items-start gap-3">
                <Globe className="w-4 h-4 text-[#A78BFA] flex-shrink-0 mt-0.5" />
                <span>
                  <span className="text-white font-bold block mb-1">Editing a live story.</span>
                  Swap assets here, or open Play Test and use <span className="text-white font-bold">Tweak This Scene</span> to
                  rewrite any single scene. Re-publish pushes the changes to every player.
                </span>
              </div>
            )}

            {draftSaved && !editingStoryId && (
              <div className="bg-[#064E3B]/30 border border-[#10B981]/40 rounded-2xl p-5 text-[#34D399] text-[15px] font-bold flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
                <span>Published to the live catalog.</span>
              </div>
            )}

            {!hasCompletedPlaythrough && (
              <div className="bg-[#1C1635] border border-[#2D1B4E] rounded-2xl p-5 text-[#C4B5FD] text-[13px] leading-relaxed flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 text-[#A78BFA] flex-shrink-0 mt-0.5" />
                <span>Play-test the story through to an ending at least once before you can publish it. This is what confirms the branch structure actually works end to end.</span>
              </div>
            )}

            {assetGenError && (
              <div className="bg-[#422006]/30 border border-[#EAB308]/40 rounded-2xl p-4 text-[#FDE047] text-[13px] leading-relaxed flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span className="flex-1">{assetGenError}</span>
                <button onClick={() => setAssetGenError(null)} className="text-[#FDE047]/60 hover:text-[#FDE047] flex-shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {!imageApiKey && (
              <div className="bg-[#120F24] border border-[#2D1B4E] rounded-2xl p-4 text-[#8A7DAB] text-[12px] leading-relaxed flex items-start gap-3">
                <Palette className="w-4 h-4 text-[#A78BFA] flex-shrink-0 mt-0.5" />
                <span className="flex-1">
                  Add an image API key in <span className="text-[#C4B5FD] font-bold">Engine Config → Asset Art</span> to
                  generate portraits and backgrounds without leaving this screen.
                </span>
              </div>
            )}

            <div>
              <div className="inline-flex items-center gap-2 bg-[#1C1635] px-4 py-2 rounded-full mb-4">
                <h4 className="text-[#A78BFA] font-bold text-xs tracking-widest uppercase">Store Description</h4>
              </div>
              <p className="text-[11px] text-[#4D3A7A] italic mb-3 pl-1 leading-relaxed">
                Shown on the featured card and the game detail screen in the player app. Two or three
                sentences works best — the featured card clamps to two lines.
              </p>
              <textarea
                value={storyDescription}
                onChange={(e) => setStoryDescription(e.target.value)}
                rows={4}
                placeholder="Back-cover blurb — the engine drafts one for you when the asset manifest is built."
                className={`${fieldClasses} resize-none`}
              />
              <p className={`text-[11px] mt-2 pl-1 ${storyDescription.length > 240 ? 'text-[#FDE047]' : 'text-[#4D3A7A]'}`}>
                {storyDescription.length} characters
                {storyDescription.length > 240 && ' — the featured card will clamp this to two lines.'}
              </p>
            </div>

            <div>
              <div className="inline-flex items-center gap-2 bg-[#1C1635] px-4 py-2 rounded-full mb-4">
                <h4 className="text-[#A78BFA] font-bold text-xs tracking-widest uppercase">
                  Characters ({assetManifest?.characters?.length || 0})
                </h4>
              </div>
              <p className="text-[11px] text-[#4D3A7A] italic mb-3 pl-1 leading-relaxed">
                One row per canonical character. Upload a portrait for each expression the story uses —
                unfilled expressions fall back to <span className="text-[#8A7DAB] not-italic font-bold">neutral</span> at play time.
                Tap the small copy icon on a tile to grab a ready-to-paste art prompt for that expression.
              </p>
              <div className="space-y-3">
                {(assetManifest?.characters || []).map(c => (
                  <CharacterAssetCard
                    key={c.name}
                    character={c}
                    uploadedByExpr={assetFiles.characters[c.name]}
                    onUpload={(exprId, file) => handleAssetFileChange('characters', c.name, file, exprId)}
                    onCopyPrompt={handleCopyExpressionPrompt}
                    copiedKey={copiedExpr}
                    onGenerate={(character, expr) => handleGenerateAsset(
                      'characters',
                      character.name,
                      [character.base_description || character.description, expr.note].filter(Boolean).join(' — '),
                      expr.id,
                    )}
                    generatingKey={generatingAssetKey}
                    canGenerate={!!imageApiKey}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="inline-flex items-center gap-2 bg-[#1C1635] px-4 py-2 rounded-full mb-4">
                <h4 className="text-[#A78BFA] font-bold text-xs tracking-widest uppercase">Backgrounds ({assetManifest?.backgrounds?.length || 0})</h4>
              </div>
              <div className="space-y-3">
                {(assetManifest?.backgrounds || []).map(b => (
                  <AssetRow
                    key={b.id}
                    id={b.id}
                    description={b.description}
                    preview={assetFiles.backgrounds[b.id]?.previewUrl || assetFiles.backgrounds[b.id]?.uploadedUrl}
                    onFile={(f) => handleAssetFileChange('backgrounds', b.id, f)}
                    onGenerate={() => handleGenerateAsset('backgrounds', b.id, b.description)}
                    isGenerating={generatingAssetKey === `backgrounds__${b.id}`}
                    canGenerate={!!imageApiKey}
                    onCopy={() => handleCopyAssetPrompt('backgrounds', b.id, b.description)}
                    justCopied={copiedExpr === `backgrounds__${b.id}`}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="inline-flex items-center gap-2 bg-[#1C1635] px-4 py-2 rounded-full mb-4">
                <h4 className="text-[#A78BFA] font-bold text-xs tracking-widest uppercase">Cover Art</h4>
              </div>
              <div className="space-y-3 pb-4">
                <AssetRow
                  id="Cover Image"
                  description={coverDescription}
                  preview={assetFiles.cover.cover?.previewUrl || assetFiles.cover.cover?.uploadedUrl}
                  onFile={(f) => handleAssetFileChange('cover', 'cover', f)}
                  onGenerate={() => handleGenerateAsset('cover', 'cover', coverDescription)}
                  isGenerating={generatingAssetKey === 'cover__cover'}
                  canGenerate={!!imageApiKey}
                  onCopy={() => handleCopyAssetPrompt('cover', 'cover', coverDescription)}
                  justCopied={copiedExpr === 'cover__cover'}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {resultJson && (
        <div className="px-6 pb-8 pt-4 bg-[#0B0B14] flex-shrink-0 flex gap-4 max-w-md mx-auto w-full z-10 border-t border-[#1C1635]">
          <button onClick={() => { setShowTestBed(true); setHasTested(true); }} className="flex-[0.8] bg-transparent border-2 border-[#3B0764] hover:bg-[#1C1635] text-white py-[18px] rounded-full font-bold text-[17px] transition-all flex items-center justify-center gap-2">
            <Play className="w-5 h-5 fill-current" /> Play Test
          </button>
          <button
            onClick={() => setShowPublishConfirm(true)}
            disabled={!hasCompletedPlaythrough || isSavingDraft || (!!publishedStoryId && !editingStoryId)}
            title={!hasCompletedPlaythrough ? "Play test through to an ending before publishing" : ""}
            className="flex-1 bg-gradient-to-r from-[#9333EA] to-[#7C3AED] hover:from-[#A855F7] hover:to-[#8B5CF6] disabled:from-[#2D1B4E] disabled:to-[#2D1B4E] disabled:text-[#8A7DAB] disabled:opacity-80 disabled:cursor-not-allowed text-white py-[18px] rounded-full font-bold text-[17px] shadow-[0_0_20px_rgba(139,92,246,0.3)] transition-all flex items-center justify-center gap-2"
          >
            {isSavingDraft ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
            {isSavingDraft
              ? (editingStoryId ? 'Re-publishing...' : 'Publishing...')
              : editingStoryId ? 'Re-publish' : publishedStoryId ? 'Published' : 'Publish'}
          </button>
        </div>
      )}
        </div>
    );
  };
  const JUDGE_RUBRIC_META = {
    choice_impact:    { label: 'Choice Impact & Agency', weight: '30%', minPass: 7.0 },
    lore_consistency: { label: 'Lore Consistency',        weight: '20%', minPass: 8.0 },
    tonal_cohesion:   { label: 'Tonal Cohesion',          weight: '20%', minPass: 7.0 },
    character_voice:  { label: 'Character Voice',         weight: '15%', minPass: 7.0 },
    narrative_flow:   { label: 'Narrative Flow',          weight: '15%', minPass: 6.0 },
  };

  const JudgeScorecard = ({ scorecard, isEvaluating, onRerun, canRerun }) => {
    const [expanded, setExpanded] = useState(true);

    const statusStyles = {
      PASS:  { text: 'text-[#34D399]', border: 'border-[#10B981]/50', icon: <CheckCircle2 className="w-4 h-4" /> },
      FAIL:  { text: 'text-[#FCA5A5]', border: 'border-[#EF4444]/50', icon: <XCircle className="w-4 h-4" /> },
      ERROR: { text: 'text-[#FDE047]', border: 'border-[#EAB308]/50', icon: <AlertTriangle className="w-4 h-4" /> },
    };
    const s = scorecard ? (statusStyles[scorecard.status] || statusStyles.ERROR) : null;

    return (
      <div className="bg-[#120F24] border border-[#2D1B4E] rounded-3xl overflow-hidden shadow-lg">
        <div className="p-5 flex items-center justify-between gap-3 cursor-pointer hover:bg-[#1C1635]/50 transition-colors" onClick={() => setExpanded(e => !e)}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#1C1635] flex items-center justify-center">
               <Scale className="w-4 h-4 text-[#A78BFA]" />
            </div>
            <h4 className="text-[15px] font-bold text-white tracking-wide">SCORECARD</h4>
          </div>
          <div className="flex items-center gap-3">
            {scorecard && scorecard.status !== 'ERROR' && (
              <span className={`text-[13px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 bg-[#0B0B14] ${s.text} border ${s.border}`}>
                {s.icon} {scorecard.status} {scorecard.overall_score != null && `· ${scorecard.overall_score}/10`}
              </span>
            )}
            <ChevronDown className={`w-5 h-5 text-[#8A7DAB] transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </div>
        </div>

        {expanded && (
          <div className="px-5 pb-5">
            {!scorecard && !isEvaluating && (
              <div className="text-[13px] text-[#8A7DAB] flex items-center justify-between gap-3 bg-[#0B0B14] rounded-2xl p-4 border border-[#1C1635]">
                <span>Not evaluated yet.</span>
                <button onClick={onRerun} disabled={!canRerun} className="bg-[#2D1B4E] hover:bg-[#3B0764] disabled:opacity-40 text-white text-[13px] font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 transition-colors">
                  <Scale className="w-4 h-4" /> Run AI Evaluation
                </button>
              </div>
            )}

            {isEvaluating && (
              <div className="text-[14px] text-[#C4B5FD] font-semibold flex items-center gap-3 bg-[#1C1635] rounded-2xl p-5 border border-[#3B0764]">
                <Loader2 className="w-5 h-5 animate-spin text-[#A78BFA]" /> Judge is reading the story...
              </div>
            )}

            {scorecard && scorecard.status === 'ERROR' && (
              <div className="text-[14px] text-[#FDE047] bg-[#422006]/30 border border-[#EAB308]/30 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <span className="leading-relaxed">{scorecard.summary}</span>
                <button onClick={onRerun} disabled={!canRerun || isEvaluating} className="bg-[#EAB308]/20 hover:bg-[#EAB308]/30 text-[#FDE047] text-[13px] font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 transition-colors whitespace-nowrap">
                  <RefreshCw className="w-4 h-4" /> Retry
                </button>
              </div>
            )}

            {scorecard && scorecard.status !== 'ERROR' && (
              <div className="space-y-5 mt-2">
                <p className="text-[#C4B5FD] text-[15px] leading-relaxed italic border-l-2 border-[#8B5CF6] pl-4">{scorecard.summary}</p>
                {scorecard.model_used && (
                  <p className="text-[#8A7DAB] text-[11px] pl-4">Judged by {scorecard.model_used}</p>
                )}

                <div className="space-y-3">
                  {Object.entries(JUDGE_RUBRIC_META).map(([key, meta]) => {
                    const m = scorecard.metrics?.[key];
                    if (!m) return null;
                    const failed = (scorecard.failed_parameters || []).includes(key);
                    const pct = Math.max(0, Math.min(100, (m.score / 10) * 100));
                    return (
                      <div key={key} className="bg-[#0B0B14] border border-[#1C1635] rounded-2xl p-4">
                        <div className="flex items-center justify-between text-[13px] mb-2.5">
                          <span className="text-white font-bold">{meta.label} <span className="text-[#8A7DAB] font-medium ml-1">({meta.weight})</span></span>
                          <span className={`font-bold text-[15px] ${failed ? 'text-[#FCA5A5]' : 'text-[#10B981]'}`}>{m.score}/10 <span className="text-[#4D3A7A] text-[11px] font-bold uppercase tracking-wider ml-2">min {meta.minPass}</span></span>
                        </div>
                        <div className="h-2 w-full bg-[#1C1635] rounded-full overflow-hidden mb-3">
                          <div className={`h-full rounded-full ${failed ? 'bg-[#EF4444]' : 'bg-[#10B981]'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <p className="text-[#8A7DAB] text-[13px] leading-relaxed">{m.feedback}</p>
                      </div>
                    );
                  })}
                </div>

                {scorecard.actionable_critiques?.length > 0 && (
                  <div className="bg-[#1C1635]/50 border border-[#2D1B4E] rounded-2xl p-5 mt-2">
                    <p className="text-[12px] font-bold text-[#A78BFA] uppercase tracking-widest mb-3">Actionable Critiques</p>
                    <ul className="space-y-2.5">
                      {scorecard.actionable_critiques.map((c, i) => (
                        <li key={i} className="text-[14px] text-white flex items-start gap-3">
                          <MinusCircle className="w-4 h-4 text-[#8B5CF6] flex-shrink-0 mt-0.5" />
                          <span className="leading-relaxed">{c}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2">
                  <p className="text-[12px] text-[#4D3A7A] italic">Advisory only.</p>
                  <button onClick={onRerun} disabled={!canRerun || isEvaluating} className="text-[13px] font-bold text-[#A78BFA] hover:text-[#C4B5FD] flex items-center gap-1.5 disabled:opacity-40 transition-colors">
                    <RefreshCw className="w-3.5 h-3.5" /> Re-run
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center font-sans selection:bg-purple-500/30">
      <div className="w-full max-w-[420px] h-[100dvh] sm:h-[850px] sm:max-h-[90vh] sm:border-[8px] border-[#1C1635] sm:rounded-[3rem] bg-[#0B0B14] overflow-hidden relative shadow-[0_0_80px_rgba(0,0,0,0.8)] flex flex-col">
        {currentView === 'home' && renderHome()}
        {currentView === 'engine_config' && renderEngineConfig()}
        {currentView === 'novel_parameters' && renderNovelParameters()}
        {currentView === 'console' && renderConsole()}
        {currentView === 'judgement' && renderJudgement()}
        {currentView === 'assets' && renderAssets()}
        {currentView === 'library' && renderLibrary()}
      </div>

      {showTestBed && resultJson && (
        <PlayTestEngine
          storyData={resultJson}
          assetFiles={assetFiles}
          assetManifest={assetManifest}
          title={title}
          subtitle={subtitle}
          taskId={taskId}
          onClose={() => setShowTestBed(false)}
          onCompletePlaythrough={handleCompletePlaythrough}
          onSceneUpdate={handleSceneUpdate}
          worldBible={worldBible}
          provider={provider}
          apiKey={apiKey}
          modelName={modelName}
          onPublish={() => setShowPublishConfirm(true)}
        />
      )}

      {showPublishConfirm && (
        <div className="fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6" onClick={() => setShowPublishConfirm(false)}>
          <div className="bg-[#13132B] w-full max-w-sm rounded-3xl p-8 text-center shadow-2xl border border-[#2D1B4E]" onClick={e => e.stopPropagation()}>
            <div className="w-16 h-16 rounded-full bg-[#2D1B4E] flex items-center justify-center mx-auto mb-6 shadow-inner">
              <CheckCircle2 className="text-white w-8 h-8" />
            </div>
            <h3 className="text-white font-bold mb-2 text-lg leading-snug">
              {editingStoryId ? 'Push these changes live?' : 'Publish this story?'}
            </h3>
            <p className="text-[#8A7DAB] text-[13px] leading-relaxed mb-8">
              {editingStoryId
                ? `"${title}${subtitle ? `: ${subtitle}` : ''}" is already live. Re-publishing replaces the story and its art for every player, including anyone mid-playthrough.`
                : `"${title}${subtitle ? `: ${subtitle}` : ''}" will go live in the public catalog immediately and become playable by anyone using the app.`}
            </p>
            <div className="flex gap-4">
              <button onClick={() => setShowPublishConfirm(false)} className="flex-1 bg-[#2D1B4E] hover:bg-[#3B0764] text-white py-4 rounded-xl font-bold transition">Cancel</button>
              <button
                onClick={() => { setShowPublishConfirm(false); handlePublish(); }}
                disabled={isSavingDraft}
                className="flex-1 py-4 rounded-xl font-bold text-white shadow-lg transition bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isSavingDraft && <Loader2 className="w-4 h-4 animate-spin" />} {editingStoryId ? 'Re-publish' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    );
}

/*
  ============================================================================
  STUDIO AUTH GATE
  ============================================================================
  The creator app used to fall back to supabase.auth.signInAnonymously() on
  first use. Every anonymous session is a NEW auth.users row, so:

    - a story generated on one phone belonged to a different user than one
      generated on another, which is why the Story Library never matched
      across devices even though both apps talk to the same database;
    - and there is no stable identity to hang row-level security on, so the
      studio tables had to stay wide open or lock everyone out.

  Both problems go away with real accounts. Create one per team member in
  Supabase (Authentication → Users → Add user) and add their uid to
  public.studio_creators — see the migration.
*/
function CreatorLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loginFieldClasses = "w-full bg-[#1C1635] border border-[#2D1B4E] rounded-2xl p-4 text-[15px] text-white focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6] transition-all placeholder:text-[#4D3A7A]";

  const handleLogin = async (e) => {
    e?.preventDefault?.();
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (signInError) throw signInError;
    } catch (err) {
      setError(err.message || 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center font-sans selection:bg-purple-500/30">
      <div className="w-full max-w-[420px] h-[100dvh] sm:h-[850px] sm:max-h-[90vh] sm:border-[8px] border-[#1C1635] sm:rounded-[3rem] bg-[#0B0B14] overflow-hidden relative shadow-[0_0_80px_rgba(0,0,0,0.8)] flex flex-col">
        <div className="flex-1 flex flex-col justify-center px-8">
          <div className="text-center mb-10">
            <div className="w-20 h-20 mx-auto mb-5 flex items-center justify-center">
              <img src={vystoriaLogo} alt="Vystoria" className="w-full h-full object-contain" />
            </div>
            <h1 className="text-4xl font-bold font-sans tracking-wide text-white mb-1">Vystoria</h1>
            <p className="text-lg text-purple-300 font-sans tracking-wide">Story Engine</p>
            <p className="text-[#4D3A7A] text-[12px] font-bold uppercase tracking-widest mt-4">Studio access only</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Studio email"
              autoComplete="username"
              className={loginFieldClasses}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              className={loginFieldClasses}
            />
            {error && <p className="text-[#FCA5A5] text-[13px] leading-relaxed px-1">{error}</p>}
            <button
              type="submit"
              disabled={busy || !email || !password}
              className="w-full bg-gradient-to-r from-[#9333EA] to-[#7C3AED] hover:from-[#A855F7] hover:to-[#8B5CF6] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-[18px] text-[17px] rounded-full shadow-[0_0_30px_rgba(139,92,246,0.4)] transition-all flex items-center justify-center gap-3"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Key className="w-5 h-5" />}
              {busy ? 'Signing in...' : 'Enter Studio'}
            </button>
          </form>

          <p className="text-[11px] text-[#4D3A7A] leading-relaxed text-center mt-8 px-2">
            Accounts are created by an admin in Supabase. Every device signed in as a studio creator
            sees the same drafts and the same published catalog.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function CreatorAppRoot() {
  const [session, setSession] = useState(undefined); // undefined = still checking

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#8B5CF6]" />
      </div>
    );
  }

  if (!session) return <CreatorLogin />;

  return <CreatorApp session={session} onSignOut={() => supabase.auth.signOut()} />;
}

/*
  ============================================================================
  PLAY-TEST ENGINE (Styled to match the new dark mobile UI)
  ============================================================================
*/
function PlayTestEngine({
  storyData, assetFiles, assetManifest, title, subtitle, taskId, onClose,
  onCompletePlaythrough, onSceneUpdate, worldBible, provider, apiKey, modelName,
  onPublish
}) {
  const [playerState, setPlayerState] = useState('main_menu'); // + 'story_end'
  const [currentSceneId, setCurrentSceneId] = useState(storyData?.starting_scene || storyData?.scenes?.[0]?.id);
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [saveSlots, setSaveSlots] = useState(Array(8).fill(null));
  const [playerError, setPlayerError] = useState(null);

  // Scene tweak modal state
  const [showTweakModal, setShowTweakModal] = useState(false);
  const [tweakInstruction, setTweakInstruction] = useState('');
  const [isTweaking, setIsTweaking] = useState(false);
  const [tweakError, setTweakError] = useState(null);

  const storyTitle = title ? (subtitle ? `${title}: ${subtitle}` : title) : (storyData?.title || 'Visual Novel');

  const currentScene = storyData?.scenes?.find(s => s.id === currentSceneId) || storyData?.scenes?.[0] || {};
  const sequenceList = currentScene.sequence || [];
  const currentSequenceBlock = sequenceList[sequenceIndex] || {};
  const isEndOfSequence = sequenceIndex >= sequenceList.length - 1;

  const bgUrl = assetFiles?.backgrounds?.[currentScene.background]?.previewUrl
             || assetFiles?.backgrounds?.[currentScene.background]?.uploadedUrl
             || null;

  // NEW: expression-aware portrait lookup. Reads assetFiles.characters[speaker]
  // (which is nested by expression id in the new shape) and picks the right
  // variant with a fallback chain to neutral, then to any available portrait.
  const portraitUrl = currentSequenceBlock.speaker
    ? pickPortraitFromEntry(
        assetFiles?.characters?.[currentSequenceBlock.speaker],
        currentSequenceBlock.expression || 'neutral'
      )
    : null;

  // Load any previously-saved test slots for this task, so a refresh
  // (or simply re-opening the play-tester) doesn't wipe the creator's
  // in-progress test run.
  useEffect(() => {
    if (!taskId) return;
    (async () => {
      try {
        const { data } = await supabase.from('generation_tasks').select('test_save_slots').eq('id', taskId).single();
        if (data?.test_save_slots?.length) {
          const slots = Array(8).fill(null);
          data.test_save_slots.forEach((s, i) => { if (i < 8) slots[i] = s; });
          setSaveSlots(slots);
        }
      } catch (err) {
        console.error('Failed to load test save slots:', err);
      }
    })();
  }, [taskId]);

  const advanceStory = () => {
    if (!storyData) return;
    const sequenceLength = currentScene.sequence?.length || 1;
    const isEndOfSeq = sequenceIndex >= sequenceLength - 1;
    const hasChoices = currentScene.choices && currentScene.choices.length > 0;
    const nextSceneExists = storyData.scenes?.some(s => s.id === currentScene.next_scene_default);

    if (!isEndOfSeq) {
      setSequenceIndex(prev => prev + 1);
    } else if (currentScene.next_scene_default && nextSceneExists) {
      setCurrentSceneId(currentScene.next_scene_default);
      setSequenceIndex(0);
    } else if (!hasChoices) {
      onCompletePlaythrough?.();
      setPlayerState('story_end');
    }
  };

  // FIX: previously this navigated to whatever `nextSceneId` a choice
  // carried without checking it actually existed as a scene. A dangling
  // reference (a hallucinated or typo'd scene id from generation) would
  // silently fall through to the `currentScene` lookup's `scenes[0]`
  // fallback above — which looked exactly like the story "looping back to
  // the beginning" instead of reaching an ending. Now an unresolvable
  // target is treated as a real dead end and surfaced clearly, instead of
  // silently resetting progress.
  const handleChoice = (nextSceneId) => {
    const targetExists = !!nextSceneId && storyData?.scenes?.some(s => s.id === nextSceneId);
    if (targetExists) {
      setCurrentSceneId(nextSceneId);
      setSequenceIndex(0);
    } else {
      setPlayerError("Dead End: this choice has no valid next_scene set.");
    }
  };

  const handleSaveSlot = async (idx) => {
    const newSlots = [...saveSlots];
    newSlots[idx] = { sceneId: currentSceneId, date: new Date().toLocaleString() };
    setSaveSlots(newSlots);

    if (taskId) {
      try {
        await supabase.from('generation_tasks').update({ test_save_slots: newSlots }).eq('id', taskId);
      } catch (err) {
        console.error('Failed to persist save slot:', err);
      }
    }

    alert(`Test progress saved to Slot ${idx + 1}! (persisted for this task)`);
  };

  const handleLoadSlot = (idx) => {
    const slot = saveSlots[idx];
    if (slot && slot.sceneId) {
      setCurrentSceneId(slot.sceneId);
      setSequenceIndex(0);
      setPlayerState('playing');
    }
  };

  const handleTweakSubmit = async () => {
    if (!tweakInstruction.trim()) return;
    if (!apiKey) {
      setTweakError('No API key configured — set one in Engine Config before tweaking scenes.');
      return;
    }
    setIsTweaking(true);
    setTweakError(null);
    try {
      const response = await fetch(`${BACKEND_URL}/tweak-scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          api_key: apiKey,
          model_name: modelName.trim(),
          world_bible: worldBible || '',
          scene: currentScene,
          instruction: tweakInstruction.trim(),
          asset_manifest: assetManifest,
        }),
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status} ${response.statusText}`;
        try {
          const errBody = await response.json();
          if (errBody?.detail) detail = errBody.detail;
        } catch (parseErr) {}
        throw new Error(detail);
      }
      const result = await response.json();
      onSceneUpdate?.(result.scene);
      setSequenceIndex(0);
      setShowTweakModal(false);
      setTweakInstruction('');
    } catch (err) {
      setTweakError(err.message);
    } finally {
      setIsTweaking(false);
    }
  };

  const Backdrop = ({ blurred }) => (
    <div className="absolute inset-0 z-0">
      {bgUrl ? (
        <img src={bgUrl} className={`w-full h-full object-cover ${blurred ? 'blur-md brightness-50' : ''}`} alt="Scene backdrop" />
      ) : (
        <div className={`w-full h-full bg-gradient-to-br from-[#1C1635] via-[#0B0B14] to-black ${blurred ? 'brightness-50' : ''}`} />
      )}
      {blurred && <div className="absolute inset-0 bg-black/40"></div>}
    </div>
  );

  if (!storyData || !storyData.scenes) {
    return (
      <div className="fixed inset-0 z-[999] bg-[#0B0B14] flex flex-col items-center justify-center text-white p-6">
        <Loader2 className="w-10 h-10 animate-spin text-[#8B5CF6] mb-6" />
        <p className="text-[15px] font-bold text-[#A78BFA] tracking-wide uppercase">Loading Story Assets...</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[999] bg-black flex items-center justify-center p-0 sm:p-6">
      <div className="w-full h-full sm:w-[90vw] sm:max-w-[1000px] sm:h-[42.6vw] sm:max-h-[473px] relative overflow-hidden bg-[#0B0B14] text-white shadow-2xl sm:rounded-[3rem] sm:border-[8px] sm:border-[#1C1635] flex flex-col justify-center">

        <div className="absolute top-6 right-6 z-50 w-10 h-10 bg-[#120F24]/80 backdrop-blur-md rounded-full flex items-center justify-center cursor-pointer hover:bg-[#2D1B4E] transition border border-[#2D1B4E]" onClick={onClose}>
          <X className="text-[#A78BFA] w-5 h-5" />
        </div>

        <div
          className="absolute top-6 left-6 z-50 bg-[#120F24]/80 backdrop-blur-md border border-[#2D1B4E] text-[#C4B5FD] text-[11px] font-mono px-4 py-2 rounded-full flex items-center gap-2 cursor-pointer hover:bg-[#2D1B4E] transition-colors"
          onClick={() => { if (playerState === 'playing') setPlayerState('paused'); }}
        >
           <Menu className="w-3.5 h-3.5 opacity-70" />
           <span>
             scene: {currentScene.id || '—'} · bg: {currentScene.background || '—'}{!bgUrl && ' (no art)'}
             {currentSequenceBlock.speaker && currentSequenceBlock.expression && (
               <> · {currentSequenceBlock.speaker}:{currentSequenceBlock.expression}{!portraitUrl && ' (no art)'}</>
             )}
           </span>
        </div>

        {playerState === 'playing' && (
          <button
            onClick={() => { setTweakError(null); setShowTweakModal(true); }}
            className="absolute top-[82px] left-6 z-50 bg-[#120F24]/80 backdrop-blur-md border border-[#8B5CF6]/40 text-[#C4B5FD] text-[11px] font-bold px-4 py-2 rounded-full flex items-center gap-2 hover:bg-[#2D1B4E] transition-colors"
          >
            <Wand2 className="w-3.5 h-3.5" /> Tweak This Scene
          </button>
        )}

        {showTweakModal && (
          <div className="fixed inset-0 z-[70] bg-black/85 backdrop-blur-sm flex items-center justify-center p-6" onClick={() => !isTweaking && setShowTweakModal(false)}>
            <div className="bg-[#120F24] border border-[#2D1B4E] rounded-3xl p-6 max-w-sm w-full shadow-2xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-white text-lg font-bold mb-1">Tweak this scene</h3>
              <p className="text-[#8A7DAB] text-[13px] mb-4 leading-relaxed">
                Scene <span className="text-[#C4B5FD] font-mono">{currentScene.id}</span> only — describe what should change. The rest of the story is untouched.
              </p>
              <textarea
                value={tweakInstruction}
                onChange={(e) => setTweakInstruction(e.target.value)}
                rows={4}
                placeholder="e.g. 'Make the villain's dialogue more arrogant' or 'reword the second choice to be less violent'"
                className="w-full bg-[#0B0B14] border border-[#2D1B4E] rounded-2xl p-4 text-[14px] text-white focus:outline-none focus:border-[#8B5CF6] resize-none mb-4"
              />
              {tweakError && <p className="text-[#FCA5A5] text-[13px] mb-4 leading-relaxed">{tweakError}</p>}
              <div className="flex gap-3">
                <button onClick={() => setShowTweakModal(false)} disabled={isTweaking} className="flex-1 bg-transparent border border-[#3B0764] text-white font-bold py-3 rounded-xl text-[14px] disabled:opacity-50">Cancel</button>
                <button
                  onClick={handleTweakSubmit}
                  disabled={isTweaking || !tweakInstruction.trim()}
                  className="flex-1 bg-[#7C3AED] hover:bg-[#8B5CF6] disabled:opacity-50 text-white font-bold py-3 rounded-xl text-[14px] flex items-center justify-center gap-2"
                >
                  {isTweaking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                  {isTweaking ? 'Rewriting...' : 'Apply Tweak'}
                </button>
              </div>
            </div>
          </div>
        )}

        {playerError && (
          <div className="absolute inset-0 z-[60] bg-black/90 backdrop-blur-sm flex items-center justify-center p-6">
            <div className="bg-[#120F24] border border-[#EF4444]/40 rounded-3xl p-8 max-w-sm w-full text-center shadow-2xl">
              <div className="w-16 h-16 bg-[#EF4444]/20 rounded-full flex items-center justify-center mx-auto mb-6">
                 <AlertTriangle className="w-8 h-8 text-[#FCA5A5]" />
              </div>
              <p className="text-white text-xl font-bold mb-2">Dead End Reached</p>
              <p className="text-[#8A7DAB] text-[14px] leading-relaxed mb-8">{playerError}</p>
              <button onClick={() => { setPlayerError(null); setPlayerState('main_menu'); setSequenceIndex(0); setCurrentSceneId(storyData?.starting_scene || storyData?.scenes?.[0]?.id); }} className="w-full bg-[#3B0764] hover:bg-[#4C1D95] text-white font-bold py-4 rounded-xl transition text-[15px]">
                Back to Main Menu
              </button>
            </div>
          </div>
        )}

        {playerState === 'main_menu' && (
          <>
            <Backdrop blurred />
            <div className="relative z-10 flex flex-col items-center justify-center w-full h-full px-8 pb-16 pt-8">
              <div className="mt-auto mb-16 text-center">
                 <h1 className="text-[32px] font-serif font-bold text-white mb-4 drop-shadow-xl leading-tight">{storyTitle}</h1>
                 <p className="text-[#A78BFA] font-bold text-[11px] tracking-widest uppercase bg-[#1C1635]/60 px-4 py-1.5 rounded-full inline-block backdrop-blur-sm">YOUR STORY BEGINS NOW</p>
              </div>

              <div className="space-y-4 w-full mt-auto">
                <button onClick={() => { setSequenceIndex(0); setCurrentSceneId(storyData?.starting_scene || storyData?.scenes?.[0]?.id); setPlayerState('playing'); }} className="w-full bg-[#7C3AED] hover:bg-[#8B5CF6] text-white font-bold py-4 rounded-2xl shadow-[0_0_20px_rgba(124,58,237,0.4)] text-[16px] transition-all transform active:scale-95">Start New Game</button>
                <button onClick={() => setPlayerState('load_menu')} className="w-full bg-[#2D1B4E]/80 backdrop-blur-md hover:bg-[#3B0764] text-white font-bold py-4 rounded-2xl text-[16px] transition border border-[#4D3A7A]/50">Load Game</button>
                <button onClick={onClose} className="w-full bg-[#2D1B4E]/80 backdrop-blur-md hover:bg-[#3B0764] text-white font-bold py-4 rounded-2xl text-[16px] transition border border-[#4D3A7A]/50">Exit Test</button>
              </div>
            </div>
          </>
        )}

        {playerState === 'paused' && (
          <>
            <Backdrop blurred />
            <div className="relative z-10 flex flex-col items-center justify-center w-full h-full px-8 pb-16 pt-8">
              <div className="mb-auto mt-20 text-center">
                 <h1 className="text-[32px] font-serif font-bold text-white mb-4 drop-shadow-xl leading-tight">Game Paused</h1>
                 <p className="text-[#A78BFA] font-bold text-[11px] tracking-widest uppercase bg-[#1C1635]/60 px-4 py-1.5 rounded-full inline-block backdrop-blur-sm">{storyTitle}</p>
              </div>

              <div className="space-y-4 w-full mt-auto">
                <button onClick={() => setPlayerState('playing')} className="w-full bg-[#7C3AED] hover:bg-[#8B5CF6] text-white font-bold py-4 rounded-2xl shadow-[0_0_20px_rgba(124,58,237,0.4)] text-[16px] transition-all transform active:scale-95">Resume</button>
                <button onClick={() => { setSequenceIndex(0); setCurrentSceneId(storyData?.starting_scene || storyData?.scenes?.[0]?.id); setPlayerState('playing'); }} className="w-full bg-[#2D1B4E]/80 backdrop-blur-md hover:bg-[#3B0764] text-white font-bold py-4 rounded-2xl text-[16px] transition border border-[#4D3A7A]/50">Start New Game</button>
                <button onClick={() => setPlayerState('save_menu')} className="w-full bg-[#2D1B4E]/80 backdrop-blur-md hover:bg-[#3B0764] text-white font-bold py-4 rounded-2xl text-[16px] transition border border-[#4D3A7A]/50">Save Game</button>
                <button onClick={() => setPlayerState('load_menu')} className="w-full bg-[#2D1B4E]/80 backdrop-blur-md hover:bg-[#3B0764] text-white font-bold py-4 rounded-2xl text-[16px] transition border border-[#4D3A7A]/50">Load Game</button>
                <button onClick={onClose} className="w-full bg-red-900/30 backdrop-blur-md hover:bg-red-900/50 text-red-200 font-bold py-4 rounded-2xl text-[16px] transition border border-red-500/30 mt-4">Exit Test</button>
              </div>
            </div>
          </>
        )}

        {playerState === 'save_menu' && (
          <>
            <Backdrop blurred />
            <div className="relative z-10 flex flex-col w-full h-full px-6 py-10 bg-[#0B0B14]/85 backdrop-blur-xl">
              <div className="flex items-center justify-between mb-8">
                <button onClick={() => setPlayerState('paused')} className="w-12 h-12 bg-[#1C1635] rounded-full flex items-center justify-center hover:bg-[#2D1B4E] transition border border-[#3B0764]">
                  <ArrowLeft className="w-6 h-6 text-[#A78BFA]" />
                </button>
                <h2 className="text-[22px] font-serif font-bold text-white tracking-wide pr-12 w-full text-center">Save Game</h2>
              </div>

              <div className="flex-1 overflow-y-auto space-y-3 pb-6 no-scrollbar">
                {saveSlots.map((slot, idx) => (
                  <button key={idx} onClick={() => handleSaveSlot(idx)} className="w-full bg-[#120F24] hover:bg-[#1C1635] border border-[#2D1B4E] hover:border-[#8B5CF6]/50 text-white text-left px-5 py-4 rounded-2xl flex items-center justify-between transition-all group">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-[#1C1635] group-hover:bg-[#3B0764] flex items-center justify-center transition-colors">
                         <Save className="w-4 h-4 text-[#A78BFA] group-hover:text-[#D8B4FE]" />
                      </div>
                      <span className="font-bold text-[16px]">Slot {idx + 1}</span>
                    </div>
                    <span className="text-[12px] text-[#8A7DAB] font-medium">{slot ? `Saved: ${slot.date}` : 'Empty Save Slot'}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {playerState === 'load_menu' && (
          <>
            <Backdrop blurred />
            <div className="relative z-10 flex flex-col w-full h-full px-6 py-10 bg-[#0B0B14]/85 backdrop-blur-xl">
              <div className="flex items-center justify-between mb-8">
                <button onClick={() => setPlayerState(storyData ? 'paused' : 'main_menu')} className="w-12 h-12 bg-[#1C1635] rounded-full flex items-center justify-center hover:bg-[#2D1B4E] transition border border-[#3B0764]">
                  <ArrowLeft className="w-6 h-6 text-[#A78BFA]" />
                </button>
                <h2 className="text-[22px] font-serif font-bold text-white tracking-wide pr-12 w-full text-center">Load Game</h2>
              </div>

              <div className="flex-1 overflow-y-auto space-y-3 pb-6 no-scrollbar">
                {saveSlots.map((slot, idx) => (
                  <button key={idx} disabled={!slot} onClick={() => handleLoadSlot(idx)} className="w-full bg-[#120F24] hover:bg-[#1C1635] border border-[#2D1B4E] hover:border-[#8B5CF6]/50 text-white text-left px-5 py-4 rounded-2xl flex items-center justify-between transition-all group disabled:opacity-50 disabled:hover:border-[#2D1B4E] disabled:hover:bg-[#120F24]">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-[#1C1635] group-hover:bg-[#3B0764] flex items-center justify-center transition-colors">
                         <Download className={`w-4 h-4 ${slot ? 'text-[#A78BFA] group-hover:text-[#D8B4FE]' : 'text-[#4D3A7A]'}`} />
                      </div>
                      <span className="font-bold text-[16px]">Slot {idx + 1}</span>
                    </div>
                    <span className="text-[12px] text-[#8A7DAB] font-medium">{slot ? `Saved: ${slot.date}` : 'No Save Data'}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {playerState === 'story_end' && (
          <>
            <Backdrop blurred />
            <div className="relative z-10 flex flex-col items-center justify-center w-full h-full px-8 pb-12 pt-8 text-center">
              <div className="mb-8">
                <CheckCircle2 className="w-16 h-16 text-[#34D399] mb-6 mx-auto" />
                <h1 className="text-[36px] font-serif font-bold text-white mb-3 drop-shadow-xl">The End</h1>
                <p className="text-[#C4B5FD] text-[15px] leading-relaxed max-w-xs mx-auto">
                  You reached a story ending. The branch structure is validated and Publish is now unlocked.
                </p>
              </div>

              <div className="space-y-3 w-full mt-auto max-w-xs mx-auto">
                <button onClick={() => { setSequenceIndex(0); setCurrentSceneId(storyData?.starting_scene || storyData?.scenes?.[0]?.id); setPlayerState('playing'); }} className="w-full bg-[#7C3AED] hover:bg-[#8B5CF6] text-white font-bold py-4 rounded-2xl shadow-[0_0_20px_rgba(124,58,237,0.4)] text-[16px] transition-all transform active:scale-95">
                  Play Again
                </button>

                {onPublish && (
                  <button onClick={() => { onPublish(); }} className="w-full bg-gradient-to-r from-[#10B981] to-[#059669] hover:from-[#34D399] hover:to-[#10B981] text-white font-bold py-4 rounded-2xl text-[16px] transition-all shadow-lg transform active:scale-95 flex items-center justify-center gap-2">
                    <CheckCircle2 className="w-5 h-5" /> Publish Story
                  </button>
                )}

                <button onClick={onClose} className="w-full bg-[#2D1B4E]/80 backdrop-blur-md hover:bg-[#3B0764] text-white font-bold py-4 rounded-2xl text-[16px] transition border border-[#4D3A7A]/50">
                  Back to Studio
                </button>
              </div>
            </div>
          </>
        )}

        {playerState === 'playing' && (
          <div className="relative z-10 w-full h-full flex flex-col overflow-hidden">
            <Backdrop />

            {portraitUrl && (
              <img
                src={portraitUrl}
                alt={`${currentSequenceBlock.speaker || 'character'} (${currentSequenceBlock.expression || 'neutral'})`}
                className="absolute bottom-0 right-4 h-[80%] max-h-[600px] object-contain drop-shadow-2xl z-30 pointer-events-none"
              />
            )}

            <div className="absolute top-6 left-6 z-50 cursor-pointer" onClick={() => setPlayerState('paused')}>
               <div className="w-48 h-10 absolute inset-0 -ml-2 -mt-1 rounded-full"></div>
            </div>

            {(!isEndOfSequence || !(currentScene.choices && currentScene.choices.length > 0)) ? (
              <div className="mt-auto relative z-40 px-4 pb-6 w-full flex justify-center cursor-pointer" onClick={advanceStory}>
                <div className="relative w-full">
                  {currentSequenceBlock.speaker && (
                    <div className="absolute -top-4 left-6 bg-[#A855F7] text-white font-bold px-5 py-1.5 rounded-full shadow-lg z-50 text-[13px] tracking-wide border border-[#C084FC]/30">
                      {currentSequenceBlock.speaker}
                    </div>
                  )}

                  <div className="bg-[#120F24]/95 backdrop-blur-xl border border-[#2D1B4E] w-full min-h-[140px] rounded-2xl p-6 pt-8 pb-8 text-white font-sans text-[16px] leading-relaxed shadow-[0_0_30px_rgba(0,0,0,0.8)] relative">
                    <span className={currentSequenceBlock.type === 'narrative' ? 'italic text-[#D8B4FE]' : 'text-gray-100'}>
                      {currentSequenceBlock.text || 'The silent dark city envelops you...'}
                    </span>

                    <div className="absolute -bottom-5 right-6 bg-white w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-105 border border-white/20">
                      <ArrowRight className="w-5 h-5 text-[#4C1D95]" strokeWidth={3} />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-auto relative z-40 px-4 pb-8 w-full flex justify-center animate-fade-in-up">
                <div className="w-full bg-[#120F24]/95 backdrop-blur-xl border border-[#2D1B4E] rounded-3xl p-6 shadow-[0_0_40px_rgba(0,0,0,0.9)]">
                  <p className="text-white text-[15px] italic font-serif mb-6 leading-relaxed opacity-90 border-l-2 border-[#8B5CF6] pl-3">
                    {currentScene.choice_prompt || "What do you think would be the best argument?"}
                  </p>
                  <div className="flex flex-col gap-3">
                    {currentScene.choices.map((choice, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleChoice(choice.next_scene)}
                        className="bg-[#2D1B4E]/80 hover:bg-[#3B0764] border border-[#4D3A7A]/50 hover:border-[#8B5CF6] text-white font-bold py-4 px-6 rounded-2xl shadow-sm transition-all text-[15px] text-center leading-tight active:scale-[0.98]"
                      >
                        {choice.text}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}