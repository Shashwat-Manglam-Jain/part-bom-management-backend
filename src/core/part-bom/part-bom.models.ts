export interface Part {
  id: string;
  partNumber: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface PartSummary {
  id: string;
  partNumber: string;
  name: string;
}

export interface ChildPartUsage extends PartSummary {
  quantity: number;
}

export interface PartDetails extends Part {
  parentCount: number;
  childCount: number;
  parentParts: PartSummary[];
  childParts: ChildPartUsage[];
}

export type AuditAction =
  | 'PART_CREATED'
  | 'PART_UPDATED'
  | 'BOM_LINK_CREATED'
  | 'BOM_LINK_UPDATED'
  | 'BOM_LINK_REMOVED';

export interface AuditLog {
  id: string;
  partId: string;
  action: AuditAction;
  message: string;
  timestamp: string;
  metadata?: Record<string, string | number>;
}

export interface BomLink {
  parentId: string;
  childId: string;
  quantity: number;
  createdAt: string;
}

export interface BomTreeNode {
  part: PartSummary;
  quantityFromParent?: number;
  hasChildren: boolean;
  children: BomTreeNode[];
}

export interface BomTreeResponse {
  rootPartId: string;
  requestedDepth: number;
  nodeLimit: number;
  nodeCount: number;
  tree: BomTreeNode;
}

export interface PartSearchFilters {
  partNumber?: string;
  name?: string;
  q?: string;
}
