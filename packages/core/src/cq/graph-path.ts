/**
 * GraphPath — the reference AnswerPath: a typed reference-walk over the
 * in-memory InstanceWorld.
 *
 * Why it exists: the dual oracle needs a second, genuinely independent way of
 * answering every CQ so the product runs end-to-end without any external
 * memory layer. The SQL oracle executes template SQL inside DuckDB; GraphPath
 * executes the template's *graph plan* by following relations in plain
 * JavaScript over the raw rows — different representation, different engine,
 * shared only the canonical Answer form. On a clean generated world the two
 * must agree on every binding (that agreement is itself a shipped test and
 * the cross-oracle metamorphic relation); a disagreement means one of the two
 * query plans — or the world — is wrong.
 *
 * The traversal is generic over the Ontology: relation typing comes from the
 * model (single-target relations resolve via their declared target,
 * multi-target ones via the `<relation>_ref_type` column the store schema
 * mandates). All FHIR-specific knowledge stays in the template graph plans.
 */
import { Effect } from "effect"
import type { Ontology, Relation } from "../ontology/model.js"
import { getEntityType } from "../ontology/model.js"
import type { InstanceWorld } from "../store/load.js"
import { relationRefColumn, relationRefTypeColumn } from "../store/schema.js"
import type { AnswerPath } from "./engine.js"
import { PathError } from "./engine.js"
import type { GraphNode, GraphView } from "./model.js"
import { answerFromSupport } from "./model.js"

/**
 * Index an InstanceWorld as a typed graph. Dangling references simply fail to
 * resolve (follow -> undefined) rather than throwing: on mutated stress worlds
 * the graph must stay walkable so the *engines* can observe the corruption.
 */
export const makeWorldGraph = (world: InstanceWorld, ontology: Ontology): GraphView => {
  const nodesByType = new Map<string, GraphNode[]>()
  const byId = new Map<string, Map<string, GraphNode>>()
  for (const [entityType, rows] of Object.entries(world)) {
    const nodes: GraphNode[] = rows.map((row) => ({ entityType, row }))
    nodesByType.set(entityType, nodes)
    const index = new Map<string, GraphNode>()
    for (const node of nodes) {
      const id = node.row["id"]
      if (typeof id === "string") index.set(id, node)
    }
    byId.set(entityType, index)
  }

  /** Relation metadata drives the typing; asking for an undeclared relation is a template bug. */
  const relationOf = (entityType: string, relation: string): Relation => {
    const found = getEntityType(ontology, entityType)?.relations.find((r) => r.name === relation)
    if (found === undefined) {
      throw new Error(`graph traversal: unknown relation ${entityType}.${relation}`)
    }
    return found
  }

  const nodes = (entityType: string): ReadonlyArray<GraphNode> => nodesByType.get(entityType) ?? []

  const node = (entityType: string, id: string): GraphNode | undefined =>
    byId.get(entityType)?.get(id)

  const follow = (from: GraphNode, relation: string): GraphNode | undefined => {
    const rel = relationOf(from.entityType, relation)
    const ref = from.row[relationRefColumn(relation)]
    if (typeof ref !== "string") return undefined
    const targetType =
      rel.target.length > 1 ? from.row[relationRefTypeColumn(relation)] : rel.target[0]
    if (typeof targetType !== "string") return undefined
    return byId.get(targetType)?.get(ref)
  }

  const incoming = (
    sourceType: string,
    relation: string,
    target: GraphNode
  ): ReadonlyArray<GraphNode> => {
    const rel = relationOf(sourceType, relation)
    const refCol = relationRefColumn(relation)
    const typeCol = relationRefTypeColumn(relation)
    const multiTarget = rel.target.length > 1
    const targetId = target.row["id"]
    if (typeof targetId !== "string") return []
    // multi-target relations must also match on ref_type — the same id could
    // legitimately exist under several entity types in hand-rolled worlds
    return nodes(sourceType).filter(
      (n) => n.row[refCol] === targetId && (!multiTarget || n.row[typeCol] === target.entityType)
    )
  }

  return { nodes, node, follow, incoming }
}

/**
 * Wrap a world as the reference AnswerPath. Each answer runs the binding's
 * template graph plan over the typed world graph and canonicalizes the
 * resulting support set with the same fold the SQL oracle uses — so a verdict
 * difference can only come from the traversal semantics, never from
 * formatting. Template plan bugs surface as PathError (graded `missing`),
 * not as suite crashes.
 */
export const makeGraphPath = (world: InstanceWorld, ontology: Ontology): AnswerPath => {
  const graph = makeWorldGraph(world, ontology)
  return {
    name: "graph-path",
    answer: (binding) =>
      Effect.try({
        try: () => answerFromSupport(binding.template.expectedKind, binding.template.graph(graph, binding)),
        catch: (cause) =>
          new PathError({
            message: `graph-path failed on template "${binding.template.id}": ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            cause
          })
      })
  }
}
