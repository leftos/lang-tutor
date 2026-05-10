import type { RunResult, SingleBufferLanguageId } from './types';

// ── Rust: public Rust Playground ──────────────────────────────────────────
async function runRust(code: string): Promise<RunResult> {
  try {
    const r = await fetch('https://play.rust-lang.org/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'stable', mode: 'debug', edition: '2021', crateType: 'bin', tests: false, code }),
    });
    const d = (await r.json()) as { success: boolean; stdout: string; stderr: string };
    if (d.success) return { ok: true, output: d.stdout || '(no output)' };
    return { ok: false, output: d.stderr || d.stdout || 'Unknown error' };
  } catch {
    return { ok: false, output: 'Could not reach Rust Playground — check your internet connection.' };
  }
}

// ── C++: Wandbox public API ───────────────────────────────────────────────
interface WandboxResponse {
  status?: string;
  compiler_message?: string;
  program_message?: string;
  program_output?: string;
}

async function runCpp(code: string): Promise<RunResult> {
  try {
    const r = await fetch('https://wandbox.org/api/compile.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compiler: 'gcc-head',
        options: 'warning,c++23,boost-nothing',
        code,
        stdin: '',
      }),
    });
    const d = (await r.json()) as WandboxResponse;
    const compilerMsg = d.compiler_message?.trim() ?? '';
    const programOut = d.program_output ?? '';
    const programErr = d.program_message?.trim() ?? '';
    const failed = d.status !== '0' || (!programOut && /\berror:/i.test(compilerMsg));
    if (failed) {
      return { ok: false, output: compilerMsg || programErr || 'Compilation failed' };
    }
    const parts = [compilerMsg, programOut].filter(Boolean);
    return { ok: true, output: parts.join('\n\n') || '(no output)' };
  } catch {
    return { ok: false, output: 'Could not reach Wandbox — check your internet connection.' };
  }
}

// ── Python: Pyodide (lazy-loaded WASM runtime) ────────────────────────────
import type { PyodideInterface } from 'pyodide';

let pyodidePromise: Promise<PyodideInterface> | null = null;

function loadPyodide(onProgress?: (msg: string) => void): Promise<PyodideInterface> {
  if (pyodidePromise === null) {
    onProgress?.('Loading Python runtime…');
    pyodidePromise = import('pyodide')
      .then(({ loadPyodide: load, version }) => load({ indexURL: `https://cdn.jsdelivr.net/pyodide/v${version}/full/` }))
      .catch((err: unknown) => {
        pyodidePromise = null;
        throw err;
      });
  }
  return pyodidePromise;
}

async function runPython(code: string, onProgress?: (msg: string) => void): Promise<RunResult> {
  try {
    const py = await loadPyodide(onProgress);
    onProgress?.('Running…');
    let stdout = '';
    let stderr = '';
    py.setStdout({
      batched: (s: string) => {
        stdout += `${s}\n`;
      },
    });
    py.setStderr({
      batched: (s: string) => {
        stderr += `${s}\n`;
      },
    });
    try {
      await py.loadPackagesFromImports(code);
      await py.runPythonAsync(code);
    } catch (e) {
      stderr += String(e);
    }
    if (stderr) {
      const combined = stdout ? `${stdout}\n${stderr}` : stderr;
      return { ok: false, output: combined };
    }
    return { ok: true, output: stdout || '(no output)' };
  } catch (e) {
    return { ok: false, output: `Python runtime failed to load: ${String(e)}` };
  }
}

// ── C#: not executed in-app (run in Visual Studio / Rider / `dotnet run`) ─
async function runCSharp(): Promise<RunResult> {
  return {
    ok: true,
    output:
      'C# is not executed in this app.\nCopy your code into Visual Studio, JetBrains Rider, or run it with `dotnet run` to see output.\nSend to tutor still works — it shares your code with the tutor for review.',
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────
export async function runCode(lang: SingleBufferLanguageId, code: string, onProgress?: (msg: string) => void): Promise<RunResult> {
  switch (lang) {
    case 'rust':
      return runRust(code);
    case 'cpp':
      onProgress?.('Compiling…');
      return runCpp(code);
    case 'python':
      return runPython(code, onProgress);
    case 'csharp':
      return runCSharp();
  }
}
