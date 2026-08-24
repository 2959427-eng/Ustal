export type OntologyNodeType =
  | "action"
  | "object"
  | "capability"
  | "resource"
  | "condition"
  | "risk";

export interface OntologyNode {
  id: string;
  canonicalKey: string;
  nameRu: string;
  description: string | null;
  nodeType: OntologyNodeType;
  parentId: string | null;
  riskLevel: number;
  regulated: boolean;
  requiresVerification: boolean;
  status: "active" | "deprecated";
  version: number;
}
