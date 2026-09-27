import { describe, expect, it } from 'vitest';
import {
  addUserFact,
  applyProfileDelta,
  emptyProfile,
  hasProfileContent,
  mergeProgress,
  migrateProfile,
  needsProfileMigration,
  PROFILE_SECTION_CAP,
  PROGRESS_LIST_CAP,
  removeFact,
  validateExtraction,
} from './learnerMemory';
import type { LearnerProfile, ProfileFact, Progress, Topic } from './types';

const NOW = '2026-09-27T12:00:00.000Z';

function idGen(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function fact(id: string, text: string, source: ProfileFact['source'], at: string): ProfileFact {
  return { id, text, source, at };
}

function profileWith(goals: ProfileFact[]): LearnerProfile {
  const p = emptyProfile();
  return { ...p, facts: { ...p.facts, goals } };
}

const TOPICS: Topic[] = [
  { id: 'hello', title: 'Hello world' },
  { id: 'vars', title: 'Variables' },
  { id: 'loops', title: 'Loops' },
];
const TOPIC_IDS = TOPICS.map((t) => t.id);

describe('migrateProfile', () => {
  it('accepts a bare string where a v1 list field was expected', () => {
    const migrated = migrateProfile({ experienceNotes: 'Ten years of .NET', goals: 'Build a game' }, '2026-09-27T00:00:00.000Z');
    expect(migrated.facts.background.map((f) => f.text)).toEqual(['Ten years of .NET']);
    expect(migrated.facts.goals.map((f) => f.text)).toEqual(['Build a game']);
  });

  it('maps every v1 field to v2 facts and drops recentSignals', () => {
    const v1 = {
      summary: 'Seasoned C# dev',
      knownLanguages: ['C#', 'Python'],
      experienceNotes: ['10 years of .NET'],
      goals: ['Write a game engine'],
      preferences: ['Compare with C#'],
      strengths: ['Reads docs'],
      struggles: ['Lifetimes'],
      recentSignals: ['Was tired today'],
      updatedAt: '2026-09-01',
    };
    const p = migrateProfile(v1, NOW, idGen());
    expect(p.version).toBe(2);
    expect(p.summary).toBe('Seasoned C# dev');
    expect(p.knownLanguages).toEqual(['C#', 'Python']);
    expect(p.facts.background.map((f) => f.text)).toEqual(['10 years of .NET']);
    expect(p.facts.goals.map((f) => f.text)).toEqual(['Write a game engine']);
    expect(p.facts.preferences.map((f) => f.text)).toEqual(['Compare with C#']);
    expect(p.facts.strengths.map((f) => f.text)).toEqual(['Reads docs']);
    expect(p.facts.struggles.map((f) => f.text)).toEqual(['Lifetimes']);
    expect(JSON.stringify(p)).not.toContain('Was tired today');
    const all = Object.values(p.facts).flat();
    expect(all.every((f) => f.source === 'tutor' && f.at === '2026-09-01')).toBe(true);
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
    expect(needsProfileMigration(v1)).toBe(true);
  });

  it('uses now for facts when the v1 profile has no updatedAt', () => {
    const p = migrateProfile({ goals: ['Ship it'] }, NOW, idGen());
    expect(p.facts.goals[0]?.at).toBe(NOW);
  });

  it('returns an empty v2 profile for null, primitives and arrays', () => {
    for (const raw of [null, undefined, 42, 'profile', [], true]) {
      const p = migrateProfile(raw, NOW, idGen());
      expect(p).toEqual(emptyProfile());
      expect(hasProfileContent(p)).toBe(false);
      expect(needsProfileMigration(raw)).toBe(false);
    }
  });

  it('drops non-string entries from malformed v1 arrays and ignores fields that are neither list nor string', () => {
    const p = migrateProfile({ goals: ['Real goal', 3, null, { text: 'x' }, '  '], preferences: { x: 1 }, strengths: 42, summary: 7 }, NOW, idGen());
    expect(p.facts.goals.map((f) => f.text)).toEqual(['Real goal']);
    expect(p.facts.preferences).toEqual([]);
    expect(p.facts.strengths).toEqual([]);
    expect(p.summary).toBeUndefined();
  });

  it('cleans a v2 profile: drops facts without string text, keeps valid ones as they are', () => {
    const raw = {
      version: 2,
      summary: 'S',
      facts: {
        goals: [
          { id: 'g1', text: 'Keep me', source: 'user', lang: 'rust', at: '2026-01-01' },
          { id: 'g2', text: 12, source: 'tutor', at: '2026-01-01' },
          { id: 'g3', source: 'tutor', at: '2026-01-01' },
          'bare string',
        ],
        bogus: [{ id: 'b', text: 'unknown section', source: 'tutor', at: NOW }],
      },
    };
    const p = migrateProfile(raw, NOW, idGen());
    expect(p.facts.goals).toEqual([{ id: 'g1', text: 'Keep me', source: 'user', lang: 'rust', at: '2026-01-01' }]);
    expect(p.facts.background).toEqual([]);
    expect(JSON.stringify(p)).not.toContain('unknown section');
    expect(needsProfileMigration(raw)).toBe(false);
  });
});

describe('applyProfileDelta', () => {
  it('adds trimmed tutor facts stamped with lang and time, deduping case and whitespace', () => {
    const start = profileWith([fact('g1', 'Build a Game Engine', 'tutor', '2026-01-01')]);
    const p = applyProfileDelta(start, { add: { goals: ['  build a   game engine ', 'Learn  SIMD', 'learn simd', '   '] } }, 'cpp', NOW, idGen('n'));
    expect(p.facts.goals.map((f) => f.text)).toEqual(['Build a Game Engine', 'Learn  SIMD']);
    expect(p.facts.goals[1]).toEqual({ id: 'n-1', text: 'Learn  SIMD', source: 'tutor', lang: 'cpp', at: NOW });
    expect(p.updatedAt).toBe(NOW);
  });

  it('a user fact is never removed by a delta', () => {
    const start = profileWith([fact('u1', 'Mine', 'user', '2026-01-01'), fact('t1', 'Tutor note', 'tutor', '2026-01-01')]);
    const p = applyProfileDelta(start, { remove: ['u1', 't1'] }, 'rust', NOW, idGen());
    expect(p.facts.goals.map((f) => f.id)).toEqual(['u1']);
  });

  it('ignores removal ids that match no fact', () => {
    const start = profileWith([fact('t1', 'Tutor note', 'tutor', '2026-01-01')]);
    const p = applyProfileDelta(start, { remove: ['nope'] }, 'rust', NOW, idGen());
    expect(p.facts.goals.map((f) => f.id)).toEqual(['t1']);
  });

  it('removes before adding, so a removed text can be re-added fresh', () => {
    const start = profileWith([fact('t1', 'Old goal', 'tutor', '2026-01-01')]);
    const p = applyProfileDelta(start, { remove: ['t1'], add: { goals: ['old goal'] } }, 'rust', NOW, idGen('n'));
    expect(p.facts.goals.map((f) => f.id)).toEqual(['n-1']);
  });

  it('caps a section by evicting the oldest tutor facts first', () => {
    const existing = Array.from({ length: PROFILE_SECTION_CAP }, (_, i) => fact(`t${i}`, `note ${i}`, 'tutor', `2026-01-0${i + 1}`));
    const p = applyProfileDelta(profileWith(existing), { add: { goals: ['newest a', 'newest b'] } }, 'rust', NOW, idGen('n'));
    expect(p.facts.goals).toHaveLength(PROFILE_SECTION_CAP);
    expect(p.facts.goals.map((f) => f.id)).not.toContain('t0');
    expect(p.facts.goals.map((f) => f.id)).not.toContain('t1');
    expect(p.facts.goals.map((f) => f.id)).toContain('n-2');
  });

  it('a user fact is never evicted while a tutor fact remains in the section', () => {
    const users = Array.from({ length: 7 }, (_, i) => fact(`u${i}`, `user ${i}`, 'user', '2000-01-01'));
    const start = profileWith([...users, fact('t-old', 'tutor old', 'tutor', '2026-01-01')]);
    const p = applyProfileDelta(start, { add: { goals: ['tutor new'] } }, 'rust', NOW, idGen('n'));
    const ids = p.facts.goals.map((f) => f.id);
    expect(ids).toHaveLength(PROFILE_SECTION_CAP);
    for (const u of users) expect(ids).toContain(u.id);
    expect(ids).not.toContain('t-old');
    expect(ids).toContain('n-1');
  });

  it('evicts the oldest user fact only when a section holds more user facts than the cap', () => {
    const users = Array.from({ length: PROFILE_SECTION_CAP + 1 }, (_, i) => fact(`u${i}`, `user ${i}`, 'user', `2026-01-0${i + 1}`));
    const p = applyProfileDelta(profileWith(users), {}, 'rust', NOW, idGen());
    expect(p.facts.goals.map((f) => f.id)).toEqual(users.slice(1).map((f) => f.id));
  });

  it('replaces summary and knownLanguages when present, deduping languages', () => {
    const start: LearnerProfile = { ...emptyProfile(), summary: 'Old', knownLanguages: ['C#'] };
    const p = applyProfileDelta(start, { summary: 'New', knownLanguages: ['Rust', ' rust ', 'Go'] }, 'rust', NOW, idGen());
    expect(p.summary).toBe('New');
    expect(p.knownLanguages).toEqual(['Rust', 'Go']);
    const unchanged = applyProfileDelta(start, {}, 'rust', NOW, idGen());
    expect(unchanged.summary).toBe('Old');
    expect(unchanged.knownLanguages).toEqual(['C#']);
  });
});

describe('addUserFact', () => {
  it('refuses whitespace-only text and leaves the profile untouched', () => {
    const start = emptyProfile();
    for (const text of ['', '   ', '\n\t ']) {
      const result = addUserFact(start, 'goals', text, NOW, idGen('n'));
      expect(result.added).toBe(false);
      expect(result.reason).toBe('empty');
      expect(result.profile).toBe(start);
    }
  });

  it('refuses a duplicate of a tutor fact, ignoring case and whitespace', () => {
    const start = profileWith([fact('t1', 'Build a Game Engine', 'tutor', '2026-01-01')]);
    const result = addUserFact(start, 'goals', '  build a   game engine ', NOW, idGen('n'));
    expect(result.added).toBe(false);
    expect(result.reason).toBe('duplicate');
    expect(result.profile).toBe(start);
    expect(result.profile.facts.goals.map((f) => f.id)).toEqual(['t1']);
  });

  it('adds a trimmed user fact stamped with the time and no language', () => {
    const result = addUserFact(emptyProfile(), 'goals', '  Ship a roguelike  ', NOW, idGen('n'));
    expect(result.added).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.profile.facts.goals).toEqual([{ id: 'n-1', text: 'Ship a roguelike', source: 'user', at: NOW }]);
    expect(result.profile.updatedAt).toBe(NOW);
  });

  it('makes room in a full section by evicting its oldest tutor fact', () => {
    const existing = Array.from({ length: PROFILE_SECTION_CAP }, (_, i) => fact(`t${i}`, `note ${i}`, 'tutor', `2026-01-0${i + 1}`));
    const result = addUserFact(profileWith(existing), 'goals', 'Mine', NOW, idGen('n'));
    expect(result.added).toBe(true);
    const ids = result.profile.facts.goals.map((f) => f.id);
    expect(ids).toHaveLength(PROFILE_SECTION_CAP);
    expect(ids).not.toContain('t0');
    expect(ids).toContain('n-1');
  });

  it('never evicts a user fact to make room', () => {
    const users = Array.from({ length: PROFILE_SECTION_CAP - 1 }, (_, i) => fact(`u${i}`, `user ${i}`, 'user', '2000-01-01'));
    const start = profileWith([...users, fact('t-old', 'tutor old', 'tutor', '2026-01-01')]);
    const result = addUserFact(start, 'goals', 'Mine', NOW, idGen('n'));
    const ids = result.profile.facts.goals.map((f) => f.id);
    expect(result.added).toBe(true);
    expect(ids).toHaveLength(PROFILE_SECTION_CAP);
    for (const u of users) expect(ids).toContain(u.id);
    expect(ids).not.toContain('t-old');
    expect(ids).toContain('n-1');
  });

  it('refuses with full when the section holds only user facts', () => {
    const start = profileWith(Array.from({ length: PROFILE_SECTION_CAP }, (_, i) => fact(`u${i}`, `user ${i}`, 'user', '2026-01-01')));
    const result = addUserFact(start, 'goals', 'One more', NOW, idGen('n'));
    expect(result.added).toBe(false);
    expect(result.reason).toBe('full');
    expect(result.profile).toBe(start);
  });
});

describe('removeFact', () => {
  it('removes a tutor fact and a user fact, stamping updatedAt', () => {
    const start = profileWith([fact('u1', 'Mine', 'user', '2026-01-01'), fact('t1', 'Theirs', 'tutor', '2026-01-01')]);
    const withoutTutor = removeFact(start, 't1');
    expect(withoutTutor.facts.goals.map((f) => f.id)).toEqual(['u1']);
    expect(withoutTutor.updatedAt).toBeDefined();
    expect(removeFact(withoutTutor, 'u1').facts.goals).toEqual([]);
  });

  it('finds the fact in whichever section holds it', () => {
    const start: LearnerProfile = {
      ...emptyProfile(),
      facts: { ...emptyProfile().facts, struggles: [fact('s1', 'Lifetimes', 'tutor', '2026-01-01')] },
    };
    expect(removeFact(start, 's1').facts.struggles).toEqual([]);
  });

  it('leaves the profile alone for an unknown id', () => {
    const start = profileWith([fact('t1', 'Theirs', 'tutor', '2026-01-01')]);
    expect(removeFact(start, 'nope')).toBe(start);
    expect(start.updatedAt).toBeUndefined();
  });
});

describe('mergeProgress', () => {
  const prev: Progress = {
    experienceLevel: 'beginner',
    currentTopic: 'Variables',
    topics: [
      { id: 'hello', title: 'Hello world', status: 'mastered' },
      { id: 'vars', title: 'Variables', status: 'in-progress' },
    ],
    strengths: ['Reads errors'],
    struggles: ['Shadowing'],
    overallNotes: 'Going well',
    sessionCount: 3,
    lastSeen: '2026-09-20',
  };

  it('mastered never regresses', () => {
    const merged = mergeProgress(prev, { topics: [{ id: 'hello', status: 'not-started' }] }, TOPICS);
    expect(merged.topics?.find((t) => t.id === 'hello')?.status).toBe('mastered');
    const again = mergeProgress(prev, { topics: [{ id: 'hello', status: 'in-progress' }] }, TOPICS);
    expect(again.topics?.find((t) => t.id === 'hello')?.status).toBe('mastered');
  });

  it('advances in-progress to mastered and not-started to in-progress', () => {
    const merged = mergeProgress(
      prev,
      {
        topics: [
          { id: 'vars', status: 'mastered' },
          { id: 'loops', status: 'in-progress' },
        ],
      },
      TOPICS
    );
    expect(merged.topics?.map((t) => t.status)).toEqual(['mastered', 'mastered', 'in-progress']);
  });

  it('every topic id is present after merge', () => {
    const merged = mergeProgress(null, {}, TOPICS);
    expect(merged.topics?.map((t) => t.id)).toEqual(TOPIC_IDS);
    expect(merged.topics?.every((t) => t.status === 'not-started')).toBe(true);
    expect(merged.topics?.map((t) => t.title)).toEqual(TOPICS.map((t) => t.title));
  });

  it('takes non-empty text fields from the extraction, else keeps prev, and leaves sessionCount/lastSeen alone', () => {
    const merged = mergeProgress(prev, { experienceLevel: 'intermediate', currentTopic: '   ' }, TOPICS);
    expect(merged.experienceLevel).toBe('intermediate');
    expect(merged.currentTopic).toBe('Variables');
    expect(merged.overallNotes).toBe('Going well');
    expect(merged.sessionCount).toBe(3);
    expect(merged.lastSeen).toBe('2026-09-20');
  });

  it('unions strengths with dedupe and keeps the newest entries up to the cap', () => {
    const extracted = Array.from({ length: PROGRESS_LIST_CAP }, (_, i) => `new ${i}`);
    const merged = mergeProgress(prev, { strengths: [...extracted], struggles: ['  shadowing ', 'Borrowing'] }, TOPICS);
    expect(merged.strengths).toEqual(extracted);
    expect(merged.struggles).toEqual(['shadowing', 'Borrowing']);
    const small = mergeProgress(prev, { strengths: ['Tests first'] }, TOPICS);
    expect(small.strengths).toEqual(['Reads errors', 'Tests first']);
  });
});

describe('validateExtraction', () => {
  it('rejects wrong top-level shapes and missing sections', () => {
    expect(validateExtraction({ progress: {} }, TOPIC_IDS)).toBeNull();
    expect(validateExtraction({ profileDelta: {} }, TOPIC_IDS)).toBeNull();
    expect(validateExtraction({ progress: [], profileDelta: {} }, TOPIC_IDS)).toBeNull();
    expect(validateExtraction({ progress: {}, profileDelta: 'x' }, TOPIC_IDS)).toBeNull();
  });

  it('drops non-array list fields, non-string entries, unknown sections, topics and statuses', () => {
    const result = validateExtraction(
      {
        progress: {
          experienceLevel: 5,
          currentTopic: 'Loops',
          strengths: 'not an array',
          struggles: ['Off-by-one', 3, null],
          topics: [{ id: 'loops', status: 'in-progress' }, { id: 'unknown', status: 'mastered' }, { id: 'vars', status: 'done' }, 'hello'],
        },
        profileDelta: {
          summary: 'Likes games',
          knownLanguages: ['C#', 1],
          add: { goals: ['Make a roguelike', 2], hobbies: ['chess'], strengths: 'x' },
          remove: 'g1',
        },
      },
      TOPIC_IDS
    );
    expect(result).toEqual({
      progress: { currentTopic: 'Loops', struggles: ['Off-by-one'], topics: [{ id: 'loops', status: 'in-progress' }] },
      profileDelta: { summary: 'Likes games', knownLanguages: ['C#'], add: { goals: ['Make a roguelike'] } },
    });
  });

  it('validateExtraction never throws on arbitrary JSON', () => {
    const garbage: unknown[] = [
      null,
      undefined,
      0,
      -1.5,
      'string',
      '',
      true,
      [],
      [1, 'two', null],
      [{ progress: {}, profileDelta: {} }],
      {},
      { progress: null, profileDelta: null },
      { progress: { topics: [null, [], { id: {}, status: [] }] }, profileDelta: { add: [], remove: [{}, []] } },
      { progress: { topics: { id: 'hello' } }, profileDelta: { add: { goals: { nested: ['x'] } }, knownLanguages: { a: 1 } } },
      { progress: { strengths: [[['deep']]] }, profileDelta: { summary: { text: 'x' } } },
    ];
    for (const json of garbage) {
      expect(() => validateExtraction(json, TOPIC_IDS)).not.toThrow();
    }
  });
});

describe('hasProfileContent', () => {
  it('is true for a summary, a known language, or any fact', () => {
    expect(hasProfileContent(emptyProfile())).toBe(false);
    expect(hasProfileContent({ ...emptyProfile(), summary: '  ' })).toBe(false);
    expect(hasProfileContent({ ...emptyProfile(), summary: 'Hi' })).toBe(true);
    expect(hasProfileContent({ ...emptyProfile(), knownLanguages: ['Go'] })).toBe(true);
    expect(hasProfileContent(profileWith([fact('g', 'Goal', 'tutor', NOW)]))).toBe(true);
  });
});
