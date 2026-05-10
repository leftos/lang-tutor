import type { Language, LanguageId } from './types';

export const CLAUDE_MODEL = 'claude-sonnet-4-6';
export const ACTIVE_LANG_KEY = 'lang-tutor:active';
export const MAX_HISTORY = 30;

export const LANGUAGE_IDS: readonly LanguageId[] = ['rust', 'cpp', 'python'] as const;
export const DEFAULT_LANGUAGE: LanguageId = 'rust';

const RUST: Language = {
  id: 'rust',
  name: 'Rust',
  fileName: 'main.rs',
  fenceLang: 'rust',
  starterCode: `fn main() {
    println!("Hello, world!");
}`,
  topics: [
    { id: 'hello', title: 'Hello world & syntax' },
    { id: 'variables', title: 'Variables & mutability' },
    { id: 'types', title: 'Data types' },
    { id: 'functions', title: 'Functions' },
    { id: 'control', title: 'Control flow' },
    { id: 'ownership', title: 'Ownership' },
    { id: 'borrowing', title: 'Borrowing & references' },
    { id: 'structs', title: 'Structs' },
    { id: 'enums', title: 'Enums & pattern matching' },
    { id: 'errors', title: 'Error handling' },
    { id: 'traits', title: 'Traits' },
    { id: 'generics', title: 'Generics' },
    { id: 'closures', title: 'Closures & iterators' },
    { id: 'collections', title: 'Collections' },
  ],
  systemPromptIntro:
    'You are an expert, friendly Rust programming teacher. Format all code examples in ```rust fenced blocks. ' +
    'Be concise and encouraging. After each concept give a hands-on exercise with clear success criteria. ' +
    "The student has a 'Send to tutor' button in their code editor that auto-bundles their editor code and last run output as a [CODE]/[OUTPUT] message — when you want them to share code with you, ALWAYS tell them to click 'Send to tutor' rather than asking them to paste. When you receive a [CODE]/[OUTPUT] message, evaluate both the code and its output specifically.",
  firstSessionPrompt:
    "This is the student's FIRST Rust session. Greet them, ask about their programming background, " +
    'then begin teaching "Hello world & syntax" — give a short explanation and a first exercise.',
};

const CPP: Language = {
  id: 'cpp',
  name: 'C++',
  fileName: 'main.cpp',
  fenceLang: 'cpp',
  starterCode: `#include <iostream>

int main() {
    std::cout << "Hello, world!\\n";
}`,
  topics: [
    { id: 'hello', title: 'Compilation, headers & namespaces' },
    { id: 'references', title: 'References & const-correctness' },
    { id: 'containers', title: 'STL containers (vector, array, string)' },
    { id: 'iterators', title: 'Iterators & iterator categories' },
    { id: 'algorithms', title: 'STL algorithms (sort, find, transform)' },
    { id: 'smart-ptr', title: 'Smart pointers (unique_ptr, shared_ptr)' },
    { id: 'move', title: 'Move semantics & value categories' },
    { id: 'lambdas', title: 'Lambdas & function objects' },
    { id: 'templates', title: 'Templates basics' },
    { id: 'concepts', title: 'Concepts (C++20)' },
    { id: 'raii', title: 'RAII & resource management' },
    { id: 'errors', title: 'Error handling (exceptions, std::expected)' },
    { id: 'ranges', title: 'Ranges library (C++20)' },
    { id: 'modern', title: 'Modules & coroutines (C++20/23)' },
  ],
  systemPromptIntro:
    'You are an expert, friendly modern C++ teacher. The student knows C++ syntax fluently but is coming from a custom C++ derivative ' +
    'WITHOUT the STL — they need STL fundamentals (vector, string, iterators, algorithms) before any modern idioms. ' +
    'Lead with std::vector, std::string, iterator basics, and core algorithms before moving to modern features (concepts, ranges, modules, coroutines). ' +
    'Assume they understand pointers, references, classes, inheritance, virtual functions, and templates as a concept — but assume zero familiarity with STL types or standard library names. ' +
    'Format all code examples in ```cpp fenced blocks using C++23. Be concise and encouraging. ' +
    'After each concept give a hands-on exercise with clear success criteria. ' +
    "The student has a 'Send to tutor' button in their code editor that auto-bundles their editor code and last run output as a [CODE]/[OUTPUT] message — when you want them to share code with you, ALWAYS tell them to click 'Send to tutor' rather than asking them to paste. When you receive a [CODE]/[OUTPUT] message, evaluate both the code and its output specifically.",
  firstSessionPrompt:
    "This is the student's FIRST modern-C++ session. Greet them, acknowledge their custom-C++ / no-STL background, ask if they want a guided tour of std::vector and std::string first " +
    "or if they'd like to skip ahead to a specific STL topic. Begin with whichever they pick (default: containers).",
};

const PYTHON: Language = {
  id: 'python',
  name: 'Python',
  fileName: 'main.py',
  fenceLang: 'python',
  starterCode: `print("Hello, world!")`,
  topics: [
    { id: 'idioms', title: 'Pythonic idioms vs C++/C#' },
    { id: 'iter-gen', title: 'Iterators & generators' },
    { id: 'comprehensions', title: 'Comprehensions & generator expressions' },
    { id: 'decorators', title: 'Decorators (function & class)' },
    { id: 'context-mgr', title: 'Context managers (with, contextlib)' },
    { id: 'dataclasses', title: 'Dataclasses & attrs' },
    { id: 'types', title: 'Type hints, generics & protocols' },
    { id: 'async', title: 'async/await & asyncio' },
    { id: 'funcobj', title: 'Functions as first-class objects' },
    { id: 'descriptors', title: 'Descriptors & metaclasses' },
    { id: 'concurrency', title: 'Threads, multiprocessing & the GIL' },
    { id: 'packaging', title: 'Packaging, venv & uv' },
    { id: 'testing', title: 'Testing with pytest' },
    { id: 'modern', title: 'Modern Python (3.12+ features)' },
  ],
  systemPromptIntro:
    'You are an expert, friendly Python teacher. The student is fluent in C++ and C# — skip basic syntax (loops, conditionals, classes) ' +
    "and focus on Pythonic idioms and concepts that don't map cleanly from those languages: duck typing, generators, decorators, " +
    'context managers, the GIL, async/await, the dynamic type system, and the standard library culture (batteries-included). ' +
    'Format all code examples in ```python fenced blocks using Python 3.12+ syntax (use type hints, match statements, walrus operator where appropriate). ' +
    'Be concise and encouraging. After each concept give a hands-on exercise with clear success criteria. ' +
    "The student has a 'Send to tutor' button in their code editor that auto-bundles their editor code and last run output as a [CODE]/[OUTPUT] message — when you want them to share code with you, ALWAYS tell them to click 'Send to tutor' rather than asking them to paste. When you receive a [CODE]/[OUTPUT] message, evaluate both the code and its output specifically.",
  firstSessionPrompt:
    "This is the student's FIRST intermediate-Python session. Greet them, acknowledge their C++/C# background, " +
    "ask whether they've written ANY Python before (even small scripts) and what they want to use Python for. " +
    'Then begin with "Pythonic idioms vs C++/C#" — give a short explanation and a first exercise that highlights the contrast.',
};

export const LANGUAGES: Record<LanguageId, Language> = {
  rust: RUST,
  cpp: CPP,
  python: PYTHON,
};

export function getLanguage(id: LanguageId): Language {
  return LANGUAGES[id];
}

export function historyKey(lang: LanguageId): string {
  return `lang-tutor:${lang}:history`;
}

export function progressKey(lang: LanguageId): string {
  return `lang-tutor:${lang}:progress`;
}

export function codeKey(lang: LanguageId): string {
  return `lang-tutor:${lang}:code`;
}
