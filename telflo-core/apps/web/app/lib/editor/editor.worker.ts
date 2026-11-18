// Workaround worker file for Vite.
// Vite can't directly bundle workers from node_modules, so this
// intermediate file imports the actual worker as a side effect.
import "monaco-editor/esm/vs/editor/editor.worker";
