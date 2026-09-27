import { LANGUAGE_IDS } from './constants';
import type {
  ExtractedProgress,
  LanguageId,
  LearnerProfile,
  MemoryExtraction,
  ProfileDelta,
  ProfileFact,
  ProfileSection,
  Progress,
  Topic,
  TopicStatus,
  TopicStatusValue,
} from './types';

export const PROFILE_SECTION_CAP = 8;
export const PROGRESS_LIST_CAP = 8;

export const PROFILE_SECTIONS: readonly ProfileSection[] = ['background', 'goals', 'preferences', 'strengths', 'struggles'] as const;

const TOPIC_STATUS_RANK: Record<TopicStatusValue, number> = { 'not-started': 0, 'in-progress': 1, mastered: 2 };

const V1_SECTION_FIELDS: ReadonlyArray<readonly [string, ProfileSection]> = [
  ['experienceNotes', 'background'],
  ['goals', 'goals'],
  ['preferences', 'preferences'],
  ['strengths', 'strengths'],
  ['struggles', 'struggles'],
];

const defaultNewId = (): string => crypto.randomUUID();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProfileSection(value: string): value is ProfileSection {
  return (PROFILE_SECTIONS as readonly string[]).includes(value);
}

function isLanguageId(value: unknown): value is LanguageId {
  return typeof value === 'string' && (LANGUAGE_IDS as readonly string[]).includes(value);
}

function isTopicStatusValue(value: unknown): value is TopicStatusValue {
  return typeof value === 'string' && value in TOPIC_STATUS_RANK;
}

/** Comparison key for dedupe: case-insensitive, whitespace-collapsed. */
function dedupeKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Keeps the string entries of an array, trimmed, dropping empty ones. Non-arrays yield `undefined`. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Dedupes by `dedupeKey`, keeping the last occurrence of each entry in its last position. */
function dedupeKeepLatest(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined) continue;
    const key = dedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.unshift(item);
  }
  return out;
}

function dedupeKeepFirst(items: readonly string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = dedupeKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyFacts(): Record<ProfileSection, ProfileFact[]> {
  return { background: [], goals: [], preferences: [], strengths: [], struggles: [] };
}

export function emptyProfile(): LearnerProfile {
  return { version: 2, facts: emptyFacts() };
}

/** True when `raw` is a stored profile that is not already in the v2 shape. */
export function needsProfileMigration(raw: unknown): boolean {
  return isRecord(raw) && raw.version !== 2;
}

function withCommonFields(profile: LearnerProfile, raw: Record<string, unknown>): LearnerProfile {
  const summary = nonEmptyString(raw.summary);
  const knownLanguages = stringList(raw.knownLanguages);
  const updatedAt = nonEmptyString(raw.updatedAt);
  const out: LearnerProfile = { ...profile };
  if (summary !== undefined) out.summary = summary;
  if (knownLanguages !== undefined && knownLanguages.length > 0) out.knownLanguages = dedupeKeepFirst(knownLanguages);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  return out;
}

function cleanFact(raw: unknown, now: string, newId: () => string): ProfileFact | null {
  if (!isRecord(raw)) return null;
  const text = nonEmptyString(raw.text);
  if (text === undefined) return null;
  const fact: ProfileFact = {
    id: nonEmptyString(raw.id) ?? newId(),
    text,
    source: raw.source === 'user' ? 'user' : 'tutor',
    at: nonEmptyString(raw.at) ?? now,
  };
  if (isLanguageId(raw.lang)) fact.lang = raw.lang;
  return fact;
}

function migrateV2(raw: Record<string, unknown>, now: string, newId: () => string): LearnerProfile {
  const facts = emptyFacts();
  const rawFacts = isRecord(raw.facts) ? raw.facts : {};
  for (const section of PROFILE_SECTIONS) {
    const entries = rawFacts[section];
    if (!Array.isArray(entries)) continue;
    facts[section] = entries.map((entry) => cleanFact(entry, now, newId)).filter((f): f is ProfileFact => f !== null);
  }
  return withCommonFields({ version: 2, facts }, raw);
}

function migrateV1(raw: Record<string, unknown>, now: string, newId: () => string): LearnerProfile {
  const at = nonEmptyString(raw.updatedAt) ?? now;
  const facts = emptyFacts();
  for (const [field, section] of V1_SECTION_FIELDS) {
    // v1 profiles were unvalidated model output, so a list field may hold a bare string.
    const value = raw[field];
    const texts = dedupeKeepFirst(typeof value === 'string' ? (stringList([value]) ?? []) : (stringList(value) ?? []));
    facts[section] = texts.map((text) => ({ id: newId(), text, source: 'tutor', at }));
  }
  return withCommonFields({ version: 2, facts }, raw);
}

/**
 * Turns whatever is stored under the learner-profile key into a clean v2 profile.
 *
 * Args:
 *   raw: The stored value — `null`, a v1 profile (string arrays), a v2 profile, or garbage.
 *   now: Timestamp given to migrated facts when the stored profile has no `updatedAt`.
 *   newId: Id generator for migrated facts.
 */
export function migrateProfile(raw: unknown, now: string, newId: () => string = defaultNewId): LearnerProfile {
  if (!isRecord(raw)) return emptyProfile();
  if (raw.version === 2) return migrateV2(raw, now, newId);
  return migrateV1(raw, now, newId);
}

function removeFacts(facts: Record<ProfileSection, ProfileFact[]>, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const doomed = new Set(ids);
  for (const section of PROFILE_SECTIONS) {
    facts[section] = facts[section].filter((f) => f.source === 'user' || !doomed.has(f.id));
  }
}

interface AddContext {
  lang: LanguageId;
  now: string;
  newId: () => string;
}

function addFacts(existing: readonly ProfileFact[], texts: readonly string[], ctx: AddContext): ProfileFact[] {
  const seen = new Set(existing.map((f) => dedupeKey(f.text)));
  const out = [...existing];
  for (const raw of texts) {
    const text = raw.trim();
    const key = dedupeKey(text);
    if (text === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: ctx.newId(), text, source: 'tutor', lang: ctx.lang, at: ctx.now });
  }
  return out;
}

/** Index of the oldest fact from `source` (earliest `at`; earlier position wins a tie), or -1. */
function oldestIndex(facts: readonly ProfileFact[], source: ProfileFact['source']): number {
  let best = -1;
  facts.forEach((fact, i) => {
    if (fact.source !== source) return;
    const current = facts[best];
    if (current === undefined || fact.at < current.at) best = i;
  });
  return best;
}

/** Evicts down to the cap: oldest tutor facts first, user facts only once no tutor fact is left. */
function capSection(facts: readonly ProfileFact[]): ProfileFact[] {
  const out = [...facts];
  while (out.length > PROFILE_SECTION_CAP) {
    const tutorIdx = oldestIndex(out, 'tutor');
    out.splice(tutorIdx !== -1 ? tutorIdx : oldestIndex(out, 'user'), 1);
  }
  return out;
}

/**
 * Applies the extractor's proposed changes to the shared profile.
 *
 * Removals run first and never touch user-added facts; additions are trimmed and deduped
 * case- and whitespace-insensitively; each section is then capped at `PROFILE_SECTION_CAP`.
 */
export function applyProfileDelta(
  profile: LearnerProfile,
  delta: ProfileDelta,
  lang: LanguageId,
  now: string,
  newId: () => string = defaultNewId
): LearnerProfile {
  const facts: Record<ProfileSection, ProfileFact[]> = { ...profile.facts };
  removeFacts(facts, delta.remove ?? []);
  const ctx: AddContext = { lang, now, newId };
  for (const section of PROFILE_SECTIONS) {
    facts[section] = capSection(addFacts(facts[section], delta.add?.[section] ?? [], ctx));
  }

  const out: LearnerProfile = { ...profile, facts, updatedAt: now };
  const summary = nonEmptyString(delta.summary);
  if (summary !== undefined) out.summary = summary;
  if (delta.knownLanguages !== undefined) {
    out.knownLanguages = dedupeKeepFirst(delta.knownLanguages.map((l) => l.trim()).filter((l) => l !== ''));
  }
  return out;
}

/** Returns a copy of `profile` with `section` replaced by `next` and `updatedAt` set to `now`. */
function withSection(profile: LearnerProfile, section: ProfileSection, next: ProfileFact[], now: string): LearnerProfile {
  const facts: Record<ProfileSection, ProfileFact[]> = { ...profile.facts };
  facts[section] = next;
  return { ...profile, facts, updatedAt: now };
}

/** Outcome of a learner-initiated add: the profile, and why it was refused when it was. */
export interface AddUserFactResult {
  profile: LearnerProfile;
  added: boolean;
  reason?: 'empty' | 'duplicate' | 'full';
}

/**
 * Adds a fact the learner typed on the Profile page.
 *
 * The text is trimmed and deduped against the section's existing facts by the same rule
 * `applyProfileDelta` uses. A section already at `PROFILE_SECTION_CAP` makes room by evicting
 * its oldest tutor fact; a section holding nothing but user facts is full and refuses the add.
 * A refused add leaves the profile untouched, and the same object is returned.
 *
 * Args:
 *   profile: The shared profile to edit.
 *   section: The section the fact belongs to.
 *   text: The learner's raw input.
 *   now: Timestamp stored on the new fact and as `updatedAt`.
 *   newId: Id generator for the new fact.
 */
export function addUserFact(
  profile: LearnerProfile,
  section: ProfileSection,
  text: string,
  now: string,
  newId: () => string = defaultNewId
): AddUserFactResult {
  const trimmed = text.trim();
  if (trimmed === '') return { profile, added: false, reason: 'empty' };

  const existing = profile.facts[section];
  const key = dedupeKey(trimmed);
  if (existing.some((f) => dedupeKey(f.text) === key)) return { profile, added: false, reason: 'duplicate' };

  let kept = existing;
  if (existing.length >= PROFILE_SECTION_CAP) {
    const evict = oldestIndex(existing, 'tutor');
    if (evict === -1) return { profile, added: false, reason: 'full' };
    kept = existing.filter((_, i) => i !== evict);
  }

  const fact: ProfileFact = { id: newId(), text: trimmed, source: 'user', at: now };
  return { profile: withSection(profile, section, [...kept, fact], now), added: true };
}

/**
 * Removes one fact by id, from whichever section holds it and whatever its source — the learner
 * may delete a tutor's note as well as their own.
 *
 * An unknown id leaves the profile untouched, and the same object is returned.
 */
export function removeFact(profile: LearnerProfile, id: string): LearnerProfile {
  for (const section of PROFILE_SECTIONS) {
    const held = profile.facts[section];
    const remaining = held.filter((f) => f.id !== id);
    if (remaining.length !== held.length) return withSection(profile, section, remaining, new Date().toISOString());
  }
  return profile;
}

function mergeTopics(prev: Progress | null, extracted: ExtractedProgress, topics: readonly Topic[]): TopicStatus[] {
  return topics.map((t) => {
    const before = prev?.topics?.find((p) => p.id === t.id)?.status ?? 'not-started';
    const after = extracted.topics?.find((p) => p.id === t.id)?.status ?? before;
    const status = TOPIC_STATUS_RANK[after] > TOPIC_STATUS_RANK[before] ? after : before;
    return { id: t.id, title: t.title, status };
  });
}

function mergeList(prev: readonly string[] | undefined, extracted: readonly string[] | undefined): string[] {
  const combined = [...(prev ?? []), ...(extracted ?? [])].map((s) => s.trim()).filter((s) => s !== '');
  return dedupeKeepLatest(combined).slice(-PROGRESS_LIST_CAP);
}

function assignText(out: Progress, key: 'experienceLevel' | 'currentTopic' | 'overallNotes', next: string | undefined): void {
  const value = nonEmptyString(next);
  if (value !== undefined) out[key] = value;
}

/**
 * Merges one extraction into a language's saved progress.
 *
 * Topic statuses only advance; every topic in `topics` appears in the result; strengths and
 * struggles are unioned, deduped and capped at the newest `PROGRESS_LIST_CAP`. `sessionCount`
 * and `lastSeen` pass through from `prev` untouched.
 */
export function mergeProgress(prev: Progress | null, extracted: ExtractedProgress, topics: readonly Topic[]): Progress {
  const out: Progress = {
    ...(prev ?? {}),
    topics: mergeTopics(prev, extracted, topics),
    strengths: mergeList(prev?.strengths, extracted.strengths),
    struggles: mergeList(prev?.struggles, extracted.struggles),
  };
  assignText(out, 'experienceLevel', extracted.experienceLevel);
  assignText(out, 'currentTopic', extracted.currentTopic);
  assignText(out, 'overallNotes', extracted.overallNotes);
  return out;
}

function validTopics(value: unknown, topicIds: readonly string[]): Array<Pick<TopicStatus, 'id' | 'status'>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<Pick<TopicStatus, 'id' | 'status'>> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { id, status } = entry;
    if (typeof id !== 'string' || !topicIds.includes(id) || !isTopicStatusValue(status)) continue;
    out.push({ id, status });
  }
  return out;
}

function validProgress(raw: Record<string, unknown>, topicIds: readonly string[]): ExtractedProgress {
  const out: ExtractedProgress = {};
  const experienceLevel = nonEmptyString(raw.experienceLevel);
  const currentTopic = nonEmptyString(raw.currentTopic);
  const overallNotes = nonEmptyString(raw.overallNotes);
  const topics = validTopics(raw.topics, topicIds);
  const strengths = stringList(raw.strengths);
  const struggles = stringList(raw.struggles);
  if (experienceLevel !== undefined) out.experienceLevel = experienceLevel;
  if (currentTopic !== undefined) out.currentTopic = currentTopic;
  if (overallNotes !== undefined) out.overallNotes = overallNotes;
  if (topics !== undefined) out.topics = topics;
  if (strengths !== undefined) out.strengths = strengths;
  if (struggles !== undefined) out.struggles = struggles;
  return out;
}

function validAdditions(value: unknown): Partial<Record<ProfileSection, string[]>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Partial<Record<ProfileSection, string[]>> = {};
  for (const [key, entries] of Object.entries(value)) {
    const texts = stringList(entries);
    if (isProfileSection(key) && texts !== undefined) out[key] = texts;
  }
  return out;
}

function validDelta(raw: Record<string, unknown>): ProfileDelta {
  const out: ProfileDelta = {};
  const summary = nonEmptyString(raw.summary);
  const knownLanguages = stringList(raw.knownLanguages);
  const add = validAdditions(raw.add);
  const remove = stringList(raw.remove);
  if (summary !== undefined) out.summary = summary;
  if (knownLanguages !== undefined) out.knownLanguages = knownLanguages;
  if (add !== undefined) out.add = add;
  if (remove !== undefined) out.remove = remove;
  return out;
}

/**
 * Shape-checks the memory extractor's parsed JSON.
 *
 * Returns `null` unless both `progress` and `profileDelta` are objects. Inside them, bad
 * entries are dropped rather than failing the whole result: non-string list items, fields of
 * the wrong type, unknown profile sections, and topics with an unknown id or status.
 *
 * Args:
 *   json: The parsed model output.
 *   topicIds: The topic ids of the language the extraction ran for.
 */
export function validateExtraction(json: unknown, topicIds: readonly string[]): MemoryExtraction | null {
  if (!isRecord(json)) return null;
  const { progress, profileDelta } = json;
  if (!isRecord(progress) || !isRecord(profileDelta)) return null;
  return { progress: validProgress(progress, topicIds), profileDelta: validDelta(profileDelta) };
}

export function hasProfileContent(profile: LearnerProfile): boolean {
  if (nonEmptyString(profile.summary) !== undefined) return true;
  if ((profile.knownLanguages ?? []).length > 0) return true;
  return PROFILE_SECTIONS.some((section) => profile.facts[section].length > 0);
}
