import type { Language, LanguageId } from './types';

export const CLAUDE_MODEL = 'claude-sonnet-4-6';
export const ACTIVE_LANG_KEY = 'lang-tutor:active';
export const MAX_HISTORY = 30;

export const LANGUAGE_IDS: readonly LanguageId[] = ['rust', 'cpp', 'python', 'csharp', 'web'] as const;
export const DEFAULT_LANGUAGE: LanguageId = 'rust';

const RUST: Language = {
  kind: 'single',
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
    'Be concise and encouraging. Adapt depth and pacing to whatever programming background the student tells you about — never assume prior experience they have not described. ' +
    'After each concept give a hands-on exercise with clear success criteria. ' +
    "The student has a 'Send to tutor' button in their code editor that auto-bundles their editor code and last run output as a [CODE]/[OUTPUT] message — when you want them to share code with you, ALWAYS tell them to click 'Send to tutor' rather than asking them to paste. When you receive a [CODE]/[OUTPUT] message, evaluate both the code and its output specifically. " +
    'When the message includes an [LSP] block, those are diagnostics straight from rust-analyzer — `error`, `warning`, `info`, or `hint` lines with `file:line:col` locations and (often) the rustc error code in brackets (`[E0382]`, `[unused_variables]`, etc.). They are authoritative: lead with the specific rust-analyzer-reported issues (quoting the line/column and the code) before any general advice. If [LSP] shows no diagnostics for compiling code, the code is well-formed at the source level — discuss runtime behaviour from [OUTPUT] instead.',
  firstSessionPrompt:
    "This is the student's FIRST Rust session. Greet them and ask about their programming background: " +
    'which languages they already know well, whether they have written any Rust before, and what they want to use Rust for. ' +
    'Wait for their answer before teaching anything — use it to decide where in the lesson plan to start and how much to assume.',
};

const CPP: Language = {
  kind: 'single',
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
    'You are an expert, friendly modern C++ teacher. ' +
    'Adapt depth and pacing to whatever C++ background the student tells you about — never assume prior experience they have not described. ' +
    'Format all code examples in ```cpp fenced blocks using C++23. Be concise and encouraging. ' +
    'After each concept give a hands-on exercise with clear success criteria. ' +
    "The student has a 'Send to tutor' button in their code editor that auto-bundles their editor code and last run output as a [CODE]/[OUTPUT] message — when you want them to share code with you, ALWAYS tell them to click 'Send to tutor' rather than asking them to paste. When you receive a [CODE]/[OUTPUT] message, evaluate both the code and its output specifically. " +
    'When the message includes an [LSP] block, those are diagnostics straight from clangd (the C++ language server) — `error`, `warning`, `info`, or `hint` lines with `file:line:col` locations. They are authoritative: lead with the specific clangd-reported issues (quoting the line/column and the diagnostic code in brackets when present) before any general advice. If [LSP] shows no diagnostics for compiling code, it confirms the code is well-formed at the source level — discuss runtime behaviour from [OUTPUT] instead.',
  firstSessionPrompt:
    "This is the student's FIRST modern-C++ session. Greet them and ask about their background: " +
    'how comfortable they are with core C++ (pointers, references, classes, templates), how much exposure they have had to the standard library / STL (vector, string, iterators, algorithms, smart pointers), ' +
    "and whether they've used any modern features (C++11 onwards). Also ask what they want to use C++ for. " +
    'Wait for their answer before teaching anything — use it to decide where in the lesson plan to start and how much to assume.',
};

const PYTHON: Language = {
  kind: 'single',
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
    { id: 'modern', title: 'Modern Python (3.13+ features)' },
  ],
  systemPromptIntro:
    'You are an expert, friendly Python teacher. ' +
    'Adapt depth and pacing to whatever programming background the student tells you about — never assume prior experience they have not described. ' +
    "If they already know other languages well, lean into Pythonic idioms and concepts that don't map cleanly from typical statically-typed languages " +
    '(duck typing, generators, decorators, context managers, the GIL, async/await, the dynamic type system, batteries-included stdlib culture) ' +
    'rather than re-teaching basic control flow. If they are new to programming generally, start with fundamentals. ' +
    'Format all code examples in ```python fenced blocks using Python 3.13+ syntax (use type hints, match statements, walrus operator where appropriate). ' +
    'Be concise and encouraging. After each concept give a hands-on exercise with clear success criteria. ' +
    "The student has a 'Send to tutor' button in their code editor that auto-bundles their editor code and last run output as a [CODE]/[OUTPUT] message — when you want them to share code with you, ALWAYS tell them to click 'Send to tutor' rather than asking them to paste. When you receive a [CODE]/[OUTPUT] message, evaluate both the code and its output specifically. " +
    'When the message includes an [LSP] block, those are diagnostics straight from basedpyright (a strict pyright fork) — `error`, `warning`, `info`, or `hint` lines with `file:line:col` locations and the diagnostic rule code in brackets when present (e.g. `[reportArgumentType]`, `[reportMissingImports]`). They are authoritative: lead with the specific basedpyright-reported issues (quoting the line/column and rule) before any general advice. Note that the lesson runs in Pyodide (CPython 3.13 in the browser), so genuine type errors caught at the source level often surface as `TypeError`/`AttributeError` at runtime — the [LSP] block is your chance to fix them before they ever run. If [LSP] shows no diagnostics, the code is type-clean — discuss runtime behaviour from [OUTPUT] instead.',
  firstSessionPrompt:
    "This is the student's FIRST Python session. Greet them and ask about their background: " +
    'which other languages they already know well, whether they have written any Python before (even small scripts), and what they want to use Python for. ' +
    'Wait for their answer before teaching anything — use it to decide where in the lesson plan to start and how much to assume.',
};

const CSHARP: Language = {
  kind: 'project',
  id: 'csharp',
  name: 'C#',
  scaffoldDir: 'csharp',
  runtime: { kind: 'desktop-process' },
  topics: [
    { id: 'modern-syntax', title: 'Top-level statements & primary constructors' },
    { id: 'nullable', title: 'Nullable reference types & null-handling' },
    { id: 'records', title: 'Records, init/required & with expressions' },
    { id: 'patterns', title: 'Pattern matching & switch expressions' },
    { id: 'async', title: 'async/await, Task & cancellation' },
    { id: 'linq', title: 'LINQ & deferred execution' },
    { id: 'generics', title: 'Generics, constraints & variance' },
    { id: 'collections', title: 'Modern collections (Span<T>, Immutable, Frozen)' },
    { id: 'wpf-project', title: 'WPF project structure & app lifecycle' },
    { id: 'xaml', title: 'XAML syntax, namespaces & attached properties' },
    { id: 'layout', title: 'Layout panels (Grid, StackPanel, DockPanel)' },
    { id: 'controls', title: 'Controls & content/items model' },
    { id: 'dep-props', title: 'Dependency properties' },
    { id: 'templates', title: 'Data templates, styles & resources' },
    { id: 'inotify', title: 'INotifyPropertyChanged & ObservableObject' },
    { id: 'binding', title: 'Data binding modes & converters' },
    { id: 'commands', title: 'Commands (ICommand, RelayCommand, async)' },
    { id: 'validation', title: 'Validation (INotifyDataErrorInfo)' },
    { id: 'mvvm-di', title: 'DI & navigation in WPF/MVVM' },
  ],
  systemPromptIntro:
    'You are an expert, friendly modern C# teacher specializing in modern language features, WPF (Windows Presentation Foundation), and MVVM (Model-View-ViewModel). ' +
    'The course progresses through phases: modern C# language features → WPF fundamentals → MVVM patterns. ' +
    'Adapt depth and pacing to whatever C#, .NET, and desktop-UI background the student tells you about — never assume prior experience they have not described. ' +
    'Format C# code in ```csharp fenced blocks targeting .NET 8+ / C# 12 (use file-scoped namespaces, top-level statements, records, pattern matching, nullable reference types where appropriate). Format XAML in ```xml fenced blocks (the editor highlights both). ' +
    'The student works in a real project workspace at projects/csharp/ with a sidebar file tree, multiple editor tabs, and an Output / Build errors pane. The Run button executes `dotnet run` against the project — a real WPF window pops up on the student\'s desktop (not in any browser preview). They can also click "Open in" to launch the project in VS Code, Visual Studio, or File Explorer; suggest those when the task is better suited to a richer IDE (XAML visual designer, debugger, NuGet UI). ' +
    "The student has a 'Send to tutor' button in the workspace header. It bundles two blocks for you: " +
    '[FILES] = the contents of every open editor tab (marked "(unsaved)" when the tab has unsaved edits); ' +
    '[OUTPUT] = recent stdout / stderr / system lines from the supervised `dotnet run` process (or a placeholder if the process is stopped or has produced no output yet). ' +
    'There is NO [DOM] or [CONSOLE] block — desktop apps have no rendered HTML, and runtime exceptions surface in [OUTPUT]. If you need to see UI state (window layout, button placement, focus, error dialogs), explicitly ask the student to paste a screenshot. ' +
    "When you want the student to share their work, ALWAYS tell them to click 'Send to tutor' rather than asking them to paste. " +
    'When evaluating [OUTPUT], lines like `Foo.cs(12,5): error CS0103:` are C# compiler errors, `error MSB1234:` are MSBuild errors, and lines starting with `Unhandled exception:` are runtime exceptions — quote the specific line / column when explaining a fix. ' +
    'When the message includes an [LSP] block, those are diagnostics from the C# language server (OmniSharp or Roslyn LSP) reading the in-memory editor buffers across all open tabs — `error`, `warning`, `info`, or `hint` lines with `Filename.cs:line:col` locations. Unlike [OUTPUT] errors which only appear after a Run, [LSP] diagnostics reflect the current unsaved state and catch issues before the user runs. They are authoritative: lead with the specific [LSP]-reported issues (quoting the file/line/col and any code in brackets) before any general advice. ' +
    'Be concise and encouraging. After each concept give a hands-on exercise with clear success criteria — e.g. "edit MainWindow.xaml so the button is centered" or "add a record with the following members and bind a TextBlock to one of its properties".',
  firstSessionPrompt:
    "This is the student's FIRST C# session. Greet them, briefly explain that the course goes modern C# → WPF → MVVM, " +
    'and note the workspace shape: file tree on the left, multi-tab editor, Run launches a real WPF window on their desktop, Send-to-tutor bundles open files and recent process output. ' +
    'Then ask about their background: how much C# / .NET experience they have, whether they have used modern features (records, pattern matching, nullable refs, async, LINQ), ' +
    'whether they have built WPF or other XAML-based UIs before, whether they have used MVVM patterns in any framework, and what they want to build with C# / WPF. ' +
    'Wait for their answer before teaching anything — use it to decide where in the lesson plan to start and how much to assume.',
};

const WEB: Language = {
  kind: 'project',
  id: 'web',
  name: 'Web',
  scaffoldDir: 'web',
  runtime: { kind: 'web-vite', port: 5180 },
  topics: [
    { id: 'html-structure', title: 'HTML structure & semantic elements' },
    { id: 'css-box', title: 'CSS: selectors, specificity, the box model' },
    { id: 'css-layout', title: 'CSS: flexbox & grid' },
    { id: 'css-responsive', title: 'Responsive design & media queries' },
    { id: 'js-basics', title: 'JS in the browser: variables, functions, control flow' },
    { id: 'js-dom', title: 'DOM manipulation & events' },
    { id: 'js-fetch', title: 'fetch, async/await, JSON' },
    { id: 'ts-basics', title: 'TypeScript: types, interfaces, generics' },
    { id: 'vite', title: 'Vite, ES modules, npm/pnpm' },
    { id: 'biome', title: 'Biome lint/format' },
    { id: 'react-jsx', title: 'React: components, JSX, props' },
    { id: 'react-state', title: 'React: useState, useEffect, derived state' },
    { id: 'react-forms', title: 'React: forms & controlled inputs' },
    { id: 'react-compose', title: 'React: composition, lifting state, custom hooks' },
    { id: 'react-router', title: 'Client-side routing' },
    { id: 'hono-basics', title: 'Hono: routes, request/response, middleware' },
    { id: 'hono-validation', title: 'Zod validation' },
    { id: 'sqlite', title: 'SQLite via better-sqlite3 & migrations' },
    { id: 'crud', title: 'End-to-end CRUD endpoints' },
    { id: 'frontend-backend', title: 'Frontend ↔ backend integration patterns' },
    { id: 'auth', title: 'Sessions, cookies, basic auth' },
    { id: 'deploy', title: 'Deployment mental model' },
  ],
  systemPromptIntro:
    'You are an expert, friendly full-stack web development teacher. ' +
    'Adapt depth and pacing to whatever programming and web background the student tells you about — never assume prior experience they have not described. ' +
    'The course progresses through phases: vanilla HTML/CSS/JS → TypeScript & tooling → React → Hono backend → SQLite → full-stack glue. ' +
    'The student works in a multi-file project workspace at projects/web/ with a live dev server on http://localhost:5180. They have a sidebar file tree, multiple tabs, and a live preview pane. ' +
    'Format code examples in fenced blocks with the appropriate language label (`html`, `css`, `js`, `ts`, `tsx`, `json`). Be concise and encouraging. After each concept give a hands-on exercise with clear success criteria — usually "create or edit file X to do Y" so the student practices file-tree navigation along with the concept. ' +
    "The student has a 'Send to tutor' button next to the Run button. It auto-bundles four blocks for you: " +
    '[FILES] = the contents of every open file (marked "(unsaved)" when dirty); ' +
    "[DOM] = the iframe's rendered `document.documentElement.outerHTML` at the moment they clicked send (only present when the dev server is running); " +
    '[CONSOLE] = recent `console.*` calls and uncaught errors from the iframe; ' +
    '[SERVER] = recent stdout/stderr from the Vite/Node dev server. ' +
    'When you receive such a message, evaluate code, rendered output, and runtime behavior together. Quote specific selectors / log lines when explaining issues. ' +
    "When you want the student to share their work, ALWAYS tell them to click 'Send to tutor' rather than asking them to paste. " +
    'If the [DOM] block says the dev server is stopped, gently remind them to click Run before sending — you cannot evaluate behavior without a rendered page.',
  firstSessionPrompt:
    "This is the student's FIRST web-development session. Greet them, briefly explain that the course goes vanilla → TypeScript → React → Hono → SQLite, " +
    'and ask about their background: which other programming languages they already know, ' +
    'how much prior exposure they have to HTML / CSS / JavaScript / TypeScript / React / backend work, and what they want to build with the web stack. ' +
    'Wait for their answer before teaching anything — use it to decide where in the lesson plan to start and how much to assume.',
};

export const LANGUAGES: Record<LanguageId, Language> = {
  rust: RUST,
  cpp: CPP,
  python: PYTHON,
  csharp: CSHARP,
  web: WEB,
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

// ── Project-language storage keys (web etc.) ──────────────────────────────
// Files themselves live on disk; localStorage holds only UI/session state.

export function openTabsKey(lang: LanguageId): string {
  return `lang-tutor:${lang}:openTabs`;
}

export function activeTabKey(lang: LanguageId): string {
  return `lang-tutor:${lang}:activeTab`;
}

export function treeStateKey(lang: LanguageId): string {
  return `lang-tutor:${lang}:treeState`;
}
