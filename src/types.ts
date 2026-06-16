export type SegmentType = 'AISLE' | 'BAY' | 'LEVEL' | 'SPACE';

export interface Segment {
  fullName: string;
  type: SegmentType;

  coordinateX: number;
  coordinateY: number;
  coordinateZ: number;

  dimensionX: number;
  dimensionY: number;
  dimensionZ: number;

  offsetX: number;
  offsetY: number;
  offsetZ: number;
}
