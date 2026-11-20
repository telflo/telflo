import { Copy, Link2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { isGroup } from "~/lib/graph/canvas-operations.js";
import { componentName } from "~/lib/graph/node-operations.js";
import type { OTelNode } from "~/lib/graph/types.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * The duplicate dialog: a receiver, processor or exporter is either copied
 * into a chosen pipeline, as a new component, or linked into another
 * pipeline as the same component (one entry in the text, named in each
 * pipeline's list).
 *
 * An instance is named as the text names it (`otlp_grpc/2` stays so, not
 * the palette's spelling), and a pipeline already has it only when a
 * component of the same type has that name there (names alone would let an
 * `otlp` exporter hide a pipeline from an `otlp` receiver). Cancel clears the
 * choices, as closing does. The options' values are the nodes' opaque ids;
 * names are text only, never an attribute.
 */

interface DuplicateNodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeId: string;
  onDuplicate: (groupId?: string) => void;
  onLink: (sourceNodeId: string, groupId: string) => void;
}

export function DuplicateNodeDialog({ open, onOpenChange, nodeId, onDuplicate, onLink }: DuplicateNodeDialogProps) {
  const [duplicateGroup, setDuplicateGroup] = useState<string>("");
  const [selectedInstance, setSelectedInstance] = useState<string>("");
  const [linkGroup, setLinkGroup] = useState<string>("");
  const nodes = useEditorStore((s) => s.graph.nodes);

  const originalNode = nodes.find((n) => n.id === nodeId);

  const groupNodes = useMemo(() => nodes.filter(isGroup), [nodes]);

  // Find all distinct instances of the same component type+subType
  // Deduplicated by YAML name (e.g., "batch" and "batch/2" are two distinct instances)
  const instances = useMemo(() => {
    if (!originalNode) return [];

    const sameTypeNodes = nodes.filter(
      (n) =>
        !isGroup(n) &&
        n.data.componentType === originalNode.data.componentType &&
        n.data.componentSubType === originalNode.data.componentSubType,
    );

    // Group by YAML name, keep one representative node per name
    const byName = new Map<string, { node: OTelNode; groups: string[] }>();
    for (const node of sameTypeNodes) {
      const yamlName = componentName(node.data);
      let instance = byName.get(yamlName);
      if (!instance) {
        instance = { node, groups: [] };
        byName.set(yamlName, instance);
      }
      if (node.parentId) {
        const groupNode = nodes.find((n) => n.id === node.parentId);
        if (groupNode) instance.groups.push(groupNode.data.label || node.parentId);
      }
    }

    return Array.from(byName.entries()).map(([yamlName, { node, groups }]) => ({
      yamlName,
      nodeId: node.id,
      groups,
    }));
  }, [nodes, originalNode]);

  // Resolve effective instance: auto-select if only one exists
  const effectiveInstance = instances.length === 1 ? instances[0]!.nodeId : selectedInstance;

  // Pipeline groups eligible for linking (don't already have the selected instance)
  const linkEligibleGroups = useMemo(() => {
    if (!effectiveInstance || !originalNode) return [];

    const instance = instances.find((i) => i.nodeId === effectiveInstance);
    if (!instance) return [];

    return groupNodes.filter(
      (group) =>
        !nodes.some(
          (n) =>
            n.parentId === group.id &&
            !isGroup(n) &&
            n.data.componentType === originalNode.data.componentType &&
            componentName(n.data) === instance.yamlName,
        ),
    );
  }, [effectiveInstance, nodes, groupNodes, instances, originalNode]);

  const reset = () => {
    setDuplicateGroup("");
    setSelectedInstance("");
    setLinkGroup("");
  };

  const handleDuplicate = () => {
    onDuplicate(duplicateGroup || undefined);
    onOpenChange(false);
    reset();
  };

  const handleLink = () => {
    if (effectiveInstance && linkGroup) {
      onLink(effectiveInstance, linkGroup);
      onOpenChange(false);
      reset();
    }
  };

  const nodeLabel = originalNode?.data.label || originalNode?.data.componentSubType || "Node";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Duplicate &ldquo;{nodeLabel}&rdquo;</DialogTitle>
          <DialogDescription>Create an independent copy or link to an existing instance.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Option 1: Independent duplicate */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Copy className="w-4 h-4" />
              Duplicate (Independent Copy)
            </div>
            <div className="flex gap-2">
              <Select value={duplicateGroup} onValueChange={setDuplicateGroup}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select pipeline..." />
                </SelectTrigger>
                <SelectContent>
                  {groupNodes.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: group.data.color }}
                        />
                        {group.data.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={handleDuplicate} disabled={!duplicateGroup}>
                Duplicate
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="flex-1 h-px bg-border" />
            or
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* Option 2: Link to instance */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Link2 className="w-4 h-4" />
              Link to Instance
            </div>
            <p className="text-xs text-muted-foreground">One YAML definition shared across multiple pipelines.</p>

            {/* Instance picker */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Instance</label>
              {instances.length === 1 ? (
                <div className="text-sm px-3 py-2 border rounded-md bg-muted/50">
                  {instances[0]!.yamlName}
                  {instances[0]!.groups.length > 0 && (
                    <span className="text-muted-foreground ml-1">({instances[0]!.groups.join(", ")})</span>
                  )}
                </div>
              ) : (
                <Select
                  value={selectedInstance}
                  onValueChange={(v) => {
                    setSelectedInstance(v);
                    setLinkGroup("");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select instance..." />
                  </SelectTrigger>
                  <SelectContent>
                    {instances.map((inst) => (
                      <SelectItem key={inst.nodeId} value={inst.nodeId}>
                        <span className="flex items-center gap-2">
                          {inst.yamlName}
                          {inst.groups.length > 0 && (
                            <span className="text-muted-foreground text-xs">({inst.groups.join(", ")})</span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Pipeline group picker */}
            {effectiveInstance && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Add to Pipeline</label>
                {linkEligibleGroups.length > 0 ? (
                  <div className="flex gap-2">
                    <Select value={linkGroup} onValueChange={setLinkGroup}>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select pipeline..." />
                      </SelectTrigger>
                      <SelectContent>
                        {linkEligibleGroups.map((group) => (
                          <SelectItem key={group.id} value={group.id}>
                            <span className="flex items-center gap-2">
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-full"
                                style={{ backgroundColor: group.data.color }}
                              />
                              {group.data.label}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button onClick={handleLink} disabled={!linkGroup}>
                      Link
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    This instance already exists in all pipeline groups.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              reset();
            }}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
