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

import React, { useState, useEffect, useRef } from 'react';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import vystoriaLogo from './assets/logo.svg';
import {
  Cpu, BookOpen, Terminal, Scale, Image as ImageIcon, Sparkles, Loader2, Key,
  Play, CheckCircle2, AlertTriangle, RefreshCw, XCircle, MinusCircle, ChevronDown,
  ArrowLeft, Menu, ArrowRight, Save, Download, X, Wand2, FileText, RotateCcw
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

export default function CreatorApp() {
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

  // Story Parameter States
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [genre, setGenre] = useState('Action / Dark Fantasy');
  const [targetLength, setTargetLength] = useState('8 chapters');
  const [tone, setTone] = useState('Dark, suspenseful, mysterious');
  const [idea, setIdea] = useState('');
  const [runEvaluation, setRunEvaluation] = useState(true);

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
  useEffect(() => {
    let pollInterval;

    if (taskId && ['pending', 'generating'].includes(taskStatus)) {
      pollInterval = setInterval(async () => {
        const { data, error } = await supabase
          .from('generation_tasks')
          .select('*')
          .eq('id', taskId)
          .single();

        if (data) {
          setTaskStatus(data.status);
          setProgress(data.progress_percent);
          setCurrentStep(data.current_step);
          setLogs(data.logs || []);
          if (data.result_json) setResultJson(data.result_json);
          if (data.asset_manifest) setAssetManifest(data.asset_manifest);
          if (data.evaluation_scorecard) setEvaluationScorecard(data.evaluation_scorecard);
          if (data.world_bible) setWorldBible(data.world_bible);
        }
      }, 2000);
    }

    return () => clearInterval(pollInterval);
  }, [taskId, taskStatus]);

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
  };

  const handlePublish = async () => {
    if (!resultJson || !taskId) return;
    setIsSavingDraft(true); // reuse the loading state

    try {
      const slug = `${title}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      // NEW: characters is nested by expression too. Shape:
      //   assets.characters = { "Amara": { neutral: url, angry: url }, ... }
      const assets = { backgrounds: {}, characters: {} };

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No active session.');

      // Upload backgrounds — reuse an already-uploaded draft URL if we have
      // one, otherwise upload fresh.
      for (const [bgId, entry] of Object.entries(assetFiles.backgrounds)) {
        let url = entry.uploadedUrl;
        if (!url && entry.file) {
          const ext = entry.file.name.split('.').pop();
          const path = `assets/${slug}/backgrounds/${bgId}.${ext}`;
          const { error } = await supabase.storage.from('visual-novels').upload(path, entry.file, { upsert: true });
          if (error) throw new Error(`Background upload failed (${bgId}): ${error.message}`);
          url = supabase.storage.from('visual-novels').getPublicUrl(path).data.publicUrl;
        }
        if (url) assets.backgrounds[bgId] = url;
      }

      // Upload characters — iterate the nested {charName: {expr: entry}} shape.
      // Each expression variant becomes its own file, and the finished map
      // stored on the story row looks like:
      //   { "Amara": { "neutral": "https://...", "worried": "https://..." } }
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
            const path = `assets/${slug}/characters/${safeName}_${safeExpr}.${ext}`;
            const { error } = await supabase.storage.from('visual-novels').upload(path, entry.file, { upsert: true });
            if (error) throw new Error(`Character upload failed (${charName}/${expr}): ${error.message}`);
            url = supabase.storage.from('visual-novels').getPublicUrl(path).data.publicUrl;
          }
          if (url) assets.characters[charName][expr] = url;
        }
        // If the creator uploaded nothing at all for this character, drop the
        // empty object so the player app's fallback logic doesn't trip on it.
        if (Object.keys(assets.characters[charName]).length === 0) {
          delete assets.characters[charName];
        }
      }

      // Upload cover — same reuse-if-already-uploaded logic.
      let coverUrl = assetFiles.cover.cover?.uploadedUrl || null;
      if (!coverUrl && assetFiles.cover.cover?.file) {
        const ext = assetFiles.cover.cover.file.name.split('.').pop();
        const path = `assets/${slug}/cover.${ext}`;
        const { error } = await supabase.storage.from('visual-novels').upload(path, assetFiles.cover.cover.file, { upsert: true });
        if (error) throw new Error(`Cover upload failed: ${error.message}`);
        coverUrl = supabase.storage.from('visual-novels').getPublicUrl(path).data.publicUrl;
      }

      // Upload story JSON
      const jsonPath = `${slug}.json`;
      const jsonBlob = new Blob([JSON.stringify(resultJson)], { type: 'application/json' });
      const { error: jsonErr } = await supabase.storage.from('visual-novels').upload(jsonPath, jsonBlob, { upsert: true });
      if (jsonErr) throw new Error(`Story JSON upload failed: ${jsonErr.message}`);
      const storyUrl = supabase.storage.from('visual-novels').getPublicUrl(jsonPath).data.publicUrl;

      // Insert into public stories catalog
      const { data: { user } } = await supabase.auth.getUser();
      const { data: storyRow, error: insertErr } = await supabase
        .from('stories')
        .insert({
          title: `${title}: ${subtitle}`,
          url: storyUrl,
          genre,
          creator_id: user?.id,
          assets,
          cover_image: coverUrl,
        })
        .select()
        .single();

      if (insertErr) throw new Error(`Catalog insert failed: ${insertErr.message}`);

      // Link back to generation task
      await supabase
        .from('generation_tasks')
        .update({ published_story_id: storyRow.id, status: 'published' })
        .eq('id', taskId);

      setPublishedStoryId(storyRow.id);
      setDraftSaved(true);
      setLogs(prev => [...prev, `✅ Published! "${title}" is now live at stories.id=${storyRow.id}`]);
    } catch (err) {
      setLogs(prev => [...prev, `[Error] Publish failed: ${err.message}`]);
      alert(`Publish failed: ${err.message}`);
    } finally {
      setIsSavingDraft(false);
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
  const fetchMyStories = async () => {
    setIsLoadingLibrary(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setMyStories([]); return; }
      const { data, error } = await supabase
        .from('generation_tasks')
        .select('id, title, provider, status, progress_percent, current_step, published_story_id, created_at')
        .eq('creator_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setMyStories(data || []);
    } catch (err) {
      console.error('Failed to load story library:', err);
      setMyStories([]);
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  // Fully rehydrates CreatorApp's state from a past generation_tasks row so
  // the creator can pick up exactly where they left off — including
  // previously-uploaded assets and playtest/publish status.
  const resumeTask = async (task) => {
    const { data, error } = await supabase.from('generation_tasks').select('*').eq('id', task.id).single();
    if (error) { alert(`Could not resume: ${error.message}`); return; }

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

    const [t, ...rest] = (data.title || '').split(':');
    setTitle((t || '').trim());
    setSubtitle(rest.join(':').trim());

    const draft = data.draft_assets || {};

    // Flat rehydrate (backgrounds, cover): {key: url} → {key: {previewUrl, uploadedUrl}}
    const flatEntries = (obj) => Object.fromEntries(
      Object.entries(obj || {}).map(([k, url]) => [k, { file: null, previewUrl: url, uploadedUrl: url }])
    );

    // Nested rehydrate for characters. The draft_assets row supports BOTH shapes:
    //   Old:  { "Amara": "https://..." }                         (single portrait per character)
    //   New:  { "Amara": { "neutral": "...", "angry": "..." } }  (per-expression)
    // We normalize old-shape drafts into the new shape by treating the single
    // URL as the "neutral" variant, so nothing gets lost on resume.
    const nestedCharEntries = (obj) => {
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

    setAssetFiles({
      characters: nestedCharEntries(draft.characters),
      backgrounds: flatEntries(draft.backgrounds),
      cover: flatEntries(draft.cover),
    });

    setCurrentView(['pending', 'generating'].includes(data.status) ? 'console' : 'home');
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
    setLogs(['[System] Sending configuration to the Vystoria Engine...']);
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

    try {
      let userId;
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (user && !userError) {
        userId = user.id;
      } else {
        await supabase.auth.signOut();
        const { data: anonData, error: anonError } = await supabase.auth.signInAnonymously();
        if (anonError) {
          throw new Error(
            `Could not create an anonymous creator account: ${anonError.message}. ` +
            `Make sure "Anonymous Sign-Ins" is enabled in Supabase → Authentication → Providers.`
          );
        }
        userId = anonData.user.id;
      }

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
          run_evaluation: runEvaluation,
          user_id: userId
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
    if (!file || !taskId) return;

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
      const path = `assets/${taskId}/${kind}/${safeKey}${suffix}.${ext}`;
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
      // flat for backgrounds/cover — same as the state shape).
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
    } catch (err) {
      console.error('Asset upload failed:', err);
      setLogs(prev => [...prev, `[Error] Failed to upload ${kind} "${key}"${isCharWithExpr ? '/' + expression : ''}: ${err.message}`]);
    }
  };

  // A simple flat row used for backgrounds and cover art. Characters get
  // their own richer component (CharacterAssetCard) below because they now
  // have per-expression upload slots.
  const AssetRow = ({ id, description, preview, onFile }) => {
    const [showModal, setShowModal] = useState(false);
    return (
      <>
        <div
          className="bg-[#1C1635] border border-transparent rounded-2xl p-4 flex items-center gap-4 hover:border-[#8B5CF6]/30 transition-all shadow-sm cursor-pointer"
          onClick={() => setShowModal(true)}
        >
          <div className="w-14 h-14 rounded-xl bg-[#0B0B14] overflow-hidden flex-shrink-0 flex items-center justify-center border border-[#2D1B4E]">
            {preview ? <img src={preview} className="w-full h-full object-cover" alt={id} /> : <ImageIcon className="w-5 h-5 text-[#4D3A7A]" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-base font-bold truncate tracking-wide">{id}</p>
            <p className="text-[#8A7DAB] text-[13px] leading-snug line-clamp-2 mt-1">{description || 'No description generated.'}</p>
          </div>
          <label
            className="bg-transparent hover:bg-[#2D1B4E] border border-[#4D3A7A] hover:border-[#8B5CF6] text-white text-xs font-bold px-4 py-2.5 rounded-xl cursor-pointer flex-shrink-0 transition-colors shadow-sm flex items-center gap-2"
            onClick={e => e.stopPropagation()}
          >
            <span className="hidden sm:inline">Upload</span>
            <UploadCloudIcon className="w-3.5 h-3.5" />
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
        </div>

        {showModal && (
          <div className="fixed inset-0 z-[999] bg-black/80 flex items-center justify-center p-6 backdrop-blur-sm" onClick={() => setShowModal(false)}>
            <div className="bg-[#120F24] border border-[#2D1B4E] rounded-3xl p-6 max-w-lg w-full shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-white text-xl font-bold">{id}</h3>
                <button onClick={() => setShowModal(false)} className="w-8 h-8 bg-[#1C1635] rounded-full flex items-center justify-center hover:bg-[#2D1B4E] transition-colors"><X className="text-[#8A7DAB] w-4 h-4" /></button>
              </div>
              <div className="bg-[#0B0B14] border border-[#1C1635] rounded-xl p-4 mb-6">
                 <p className="text-[#C4B5FD] text-[15px] leading-relaxed select-all">{description || 'No description generated.'}</p>
              </div>
              <label className="w-full bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-bold py-3.5 rounded-xl cursor-pointer transition-colors flex items-center justify-center gap-2">
                <UploadCloudIcon className="w-4 h-4" /> Upload Art
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); setShowModal(false); }} />
              </label>
            </div>
          </div>
        )}
      </>
    );
  };

  // Per-character asset card: one row per character, with a grid of upload
  // slots — one slot per expression the story actually uses for them. The
  // character's shared base description is shown once at the top; each
  // expression tile shows its own short "note" underneath its filename tag.
  const CharacterAssetCard = ({ character, uploadedByExpr, onUpload }) => {
    const expressions = character.expressions?.length
      ? character.expressions
      : [{ id: 'neutral', note: '' }];

    return (
      <div className="bg-[#1C1635] border border-[#2D1B4E] rounded-2xl p-4">
        <div className="mb-4">
          <p className="text-white font-bold text-base tracking-wide">{character.name}</p>
          <p className="text-[#8A7DAB] text-[13px] leading-snug mt-1">
            {character.base_description || character.description || 'No description generated.'}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {expressions.map(expr => {
            const entry = uploadedByExpr?.[expr.id];
            const preview = entry?.previewUrl || entry?.uploadedUrl;
            return (
              <label
                key={expr.id}
                className="relative aspect-square bg-[#0B0B14] border border-[#2D1B4E] rounded-lg overflow-hidden cursor-pointer hover:border-[#8B5CF6]/60 transition-colors group"
                title={expr.note || expr.id}
              >
                {preview ? (
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

  const renderHome = () => (
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

        {taskStatus === 'failed' && (
          <p className="text-[#FCA5A5] text-[12px] font-semibold text-center max-w-xs leading-relaxed mb-6 px-2">
            Last attempt failed — see the Generation Console for details. Engine Config is unlocked, so fix it and hit Initialize Pipeline again.
          </p>
        )}

        <div className="w-full space-y-4 max-w-md mx-auto">
          <NavPill
            icon={Cpu}
            label="Engine Config"
            description={`${provider}${modelName.trim() ? ' · ' + modelName.trim().split('-')[0] : ' · auto-selected model'}`}
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
            description="Art, play-test & save"
            onClick={() => setCurrentView('assets')}
            disabled={!resultJson}
          />
          <NavPill
            icon={FileText}
            label="Story Library"
            description={myStories.length ? `${myStories.length} saved` : 'Browse past drafts'}
            onClick={() => { fetchMyStories(); setCurrentView('library'); }}
          />
        </div>
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
            <RotateCcw className="w-4 h-4" /> {taskStatus === 'failed' ? 'Start Completely Fresh' : 'Start New Story'}
          </button>
        ) : null}
      </div>
    </div>
  );

  const renderEngineConfig = () => (
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
              Or paste any model ID your key has access to — old or new, it doesn't matter which provider. If a run ever fails because a
              model was retired or renamed, come back here, clear or change this field, and hit Initialize Pipeline again — nothing else
              needs to change.
            </p>
          </div>
          <div>
            <FieldLabel><span className="flex items-center gap-2"><Key className="w-4 h-4" /> Secret API Key</span></FieldLabel>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={`Enter ${provider} API Key`} className={fieldClasses} />
            <p className="text-xs text-[#8A7DAB] mt-3 leading-relaxed pl-1">Stored only in this session — never written to the story catalog.</p>
          </div>
        </div>
      </div>
      <div className="px-6 pb-8 pt-4 flex-shrink-0 max-w-md mx-auto w-full">
        <button onClick={() => setCurrentView('home')} className="w-full bg-[#1C1635] hover:bg-[#2D1B4E] border border-[#3B0764] text-white font-bold py-[18px] text-[17px] rounded-full shadow-lg transition-all">Done</button>
      </div>
    </div>
  );

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

          <label className="flex items-start gap-4 bg-[#120F24] border border-[#2D1B4E] rounded-2xl p-5 cursor-pointer mt-4">
            <div className="pt-0.5">
               <input
                 type="checkbox"
                 checked={runEvaluation}
                 onChange={(e) => setRunEvaluation(e.target.checked)}
                 className="w-5 h-5 accent-[#8B5CF6] rounded-md border-[#4D3A7A] bg-[#0B0B14]"
               />
            </div>
            <div className="flex-1">
              <span className="text-[15px] font-bold text-white block mb-1">Run AI Quality Judge</span>
              <span className="text-[13px] text-[#8A7DAB] block leading-relaxed">
                Adds an extra API call to evaluate the final draft. Turn off to save quota on free-tier keys.
              </span>
            </div>
          </label>
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
        <ScreenHeader title="Story Library" subtitleText="Resume a draft or review a published story." />
        {isLoadingLibrary ? (
          <div className="text-center py-20"><Loader2 className="w-6 h-6 animate-spin mx-auto text-[#8B5CF6]" /></div>
        ) : myStories.length === 0 ? (
          <div className="text-center text-[#4D3A7A] text-[15px] py-20 italic">No stories generated yet.</div>
        ) : (
          <div className="space-y-3">
            {myStories.map(t => (
              <button key={t.id} onClick={() => resumeTask(t)} className="w-full text-left bg-[#1C1635] border border-[#2D1B4E] rounded-2xl p-4 hover:border-[#8B5CF6]/50 transition-all">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white font-bold truncate">{t.title || 'Untitled'}</span>
                  <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full flex-shrink-0 ml-2 ${t.published_story_id ? 'bg-[#10B981]/20 text-[#34D399]' : 'bg-[#2D1B4E] text-[#A78BFA]'}`}>
                    {t.published_story_id ? 'Published' : t.status}
                  </span>
                </div>
                <p className="text-[#8A7DAB] text-xs">{t.provider} · {t.current_step || '—'} · {t.progress_percent ?? 0}%</p>
              </button>
            ))}
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

  const renderAssets = () => (
    <div className="flex flex-col h-full bg-[#0B0B14]">
      <div className="flex-1 overflow-y-auto px-6 pt-12 pb-6 max-w-md mx-auto w-full">
        <ScreenHeader title="Story Assets" subtitleText="Attach art, play-test end to end, then save." />

        {!resultJson ? (
          <div className="text-center text-[#4D3A7A] text-[15px] py-20 italic">Generate a story first.</div>
        ) : (
          <div className="space-y-8">
            {draftSaved && (
              <div className="bg-[#064E3B]/30 border border-[#10B981]/40 rounded-2xl p-5 text-[#34D399] text-[15px] font-bold flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
                <span>Draft saved. Publishing to the live catalog is a separate, manual review step.</span>
              </div>
            )}

            {!hasCompletedPlaythrough && (
              <div className="bg-[#1C1635] border border-[#2D1B4E] rounded-2xl p-5 text-[#C4B5FD] text-[13px] leading-relaxed flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 text-[#A78BFA] flex-shrink-0 mt-0.5" />
                <span>Play-test the story through to an ending at least once before you can save it as a draft. This is what confirms the branch structure actually works end to end.</span>
              </div>
            )}

            <div>
              <div className="inline-flex items-center gap-2 bg-[#1C1635] px-4 py-2 rounded-full mb-4">
                <h4 className="text-[#A78BFA] font-bold text-xs tracking-widest uppercase">
                  Characters ({assetManifest?.characters?.length || 0})
                </h4>
              </div>
              <p className="text-[11px] text-[#4D3A7A] italic mb-3 pl-1 leading-relaxed">
                One row per canonical character. Upload a portrait for each expression the story uses —
                unfilled expressions fall back to <span className="text-[#8A7DAB] not-italic font-bold">neutral</span> at play time.
              </p>
              <div className="space-y-3">
                {(assetManifest?.characters || []).map(c => (
                  <CharacterAssetCard
                    key={c.name}
                    character={c}
                    uploadedByExpr={assetFiles.characters[c.name]}
                    onUpload={(exprId, file) => handleAssetFileChange('characters', c.name, file, exprId)}
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
                  <AssetRow key={b.id} id={b.id} description={b.description} preview={assetFiles.backgrounds[b.id]?.previewUrl || assetFiles.backgrounds[b.id]?.uploadedUrl} onFile={(f) => handleAssetFileChange('backgrounds', b.id, f)} />
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
                  description={assetManifest?.cover?.description || "Key art for your visual novel cover."}
                  preview={assetFiles.cover.cover?.previewUrl || assetFiles.cover.cover?.uploadedUrl}
                  onFile={(f) => handleAssetFileChange('cover', 'cover', f)}
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
            onClick={handlePublish}
            disabled={!hasCompletedPlaythrough || isSavingDraft || !!publishedStoryId}
            title={!hasCompletedPlaythrough ? "Play test through to an ending before publishing" : ""}
            className="flex-1 bg-gradient-to-r from-[#9333EA] to-[#7C3AED] hover:from-[#A855F7] hover:to-[#8B5CF6] disabled:from-[#2D1B4E] disabled:to-[#2D1B4E] disabled:text-[#8A7DAB] disabled:opacity-80 disabled:cursor-not-allowed text-white py-[18px] rounded-full font-bold text-[17px] shadow-[0_0_20px_rgba(139,92,246,0.3)] transition-all flex items-center justify-center gap-2"
          >
            {isSavingDraft ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
            {isSavingDraft ? 'Publishing...' : publishedStoryId ? 'Published' : 'Publish'}
          </button>
        </div>
      )}
    </div>
  );

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
          onPublish={handlePublish}
        />
      )}
    </div>
  );
}

/*
  ============================================================================
  PLAY-TEST ENGINE (Styled to match the new dark mobile UI)
  ============================================================================
*/
function PlayTestEngine({
  storyData, assetFiles, title, subtitle, taskId, onClose,
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

  const handleChoice = (nextSceneId) => {
    if (nextSceneId) {
      setCurrentSceneId(nextSceneId);
      setSequenceIndex(0);
    } else {
      setPlayerError("Dead End: this choice has no next_scene set.");
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
      <div className="w-full h-full sm:h-[850px] sm:max-h-[90vh] sm:max-w-[420px] relative overflow-hidden bg-[#0B0B14] text-white shadow-2xl sm:rounded-[3rem] sm:border-[8px] sm:border-[#1C1635] flex flex-col justify-center">

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