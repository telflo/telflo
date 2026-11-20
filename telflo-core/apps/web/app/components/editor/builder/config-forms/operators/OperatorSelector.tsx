import { Plus } from "lucide-react";
import { useState } from "react";

import { OPERATOR_CATEGORIES, OPERATORS, type OperatorCategory, type OperatorType } from "./operator-catalog.js";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog.js";
import { OWN_KEYS_PROPS } from "~/hooks/useUndoRedo.js";

/*
 * The operator selector: the "Add Operator" dialog, its four categories and
 * 26 types. Choosing a type hands it to the pipeline, which appends the
 * type's seed (`operatorSeed`) as one item, and closes the dialog.
 *
 * - every type shows its own icon (the catalog's), never a `FileText`
 *   fallback;
 * - the dialog's content spreads `OWN_KEYS_PROPS`: it renders in `<body>`,
 *   outside the Configuration tab's marker, so Delete, Backspace and
 *   Cmd/Ctrl+D on a focused type would otherwise delete or duplicate the
 *   selected receiver;
 * - the type buttons are `type="button"`, as every button in the forms.
 * No attribute carries anything from the text: the dialog holds only the
 * catalog's fixed names.
 */

const CATEGORY_TINTS: Readonly<Record<OperatorCategory, string>> = {
  parser: "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400",
  field_parser: "bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400",
  transform: "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400",
  flow: "bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400",
};

export function OperatorSelector({ onSelect, disabled = false }: { onSelect: (type: OperatorType) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);

  const handleSelect = (type: OperatorType) => {
    onSelect(type);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full" disabled={disabled}>
          <Plus className="w-4 h-4 mr-2" />
          Add Operator
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[80vh] overflow-hidden flex flex-col" {...OWN_KEYS_PROPS}>
        <DialogHeader>
          <DialogTitle>Add Operator</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto flex-1 -mx-6 px-6">
          {OPERATOR_CATEGORIES.map(({ category, label, description }) => (
            <div key={category} className="mb-4 last:mb-0">
              <div className="mb-2">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{label}</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">{description}</p>
              </div>
              <div className="space-y-1">
                {OPERATORS.filter((op) => op.category === category).map((op) => {
                  const Icon = op.icon;
                  return (
                    <button
                      key={op.type}
                      type="button"
                      onClick={() => handleSelect(op.type)}
                      className="w-full flex items-start gap-3 p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-left transition-colors"
                    >
                      <div className={`p-1.5 rounded ${CATEGORY_TINTS[category]}`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{op.label}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{op.description}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
