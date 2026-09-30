/**
 * Where `scripts/setup.ps1` (the `pses` recipe) unpacks the pinned PowerShell
 * Editor Services release bundle. The bundle carries the language server
 * (`tools/lsp.mjs`) and the PSScriptAnalyzer module behind /format
 * (`tools/checker.mjs`); both read their paths from here. Keep the relative
 * path in step with `$psesDir` in scripts/setup.ps1.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The bundle folder, relative to the repo root. */
export const PSES_BUNDLE_REL = join('.local', 'tools', 'PowerShellEditorServices');

/** The bundle's language-server entry script, relative to the repo root. */
export const PSES_START_SCRIPT_REL = join(PSES_BUNDLE_REL, 'PowerShellEditorServices', 'Start-EditorServices.ps1');

/** Absolute path of the bundle folder. */
export const PSES_BUNDLE_DIR = join(REPO_ROOT, PSES_BUNDLE_REL);

/** Absolute path of the bundle's language-server entry script. */
export const PSES_START_SCRIPT = join(REPO_ROOT, PSES_START_SCRIPT_REL);

/** Absolute path of the bundled PSScriptAnalyzer module folder (holds one versioned subfolder). */
export const PSSA_MODULE_DIR = join(PSES_BUNDLE_DIR, 'PSScriptAnalyzer');
