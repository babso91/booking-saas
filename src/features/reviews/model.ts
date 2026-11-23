export type ReviewPage = {
  count: number;
  average: number | null;
  reviews: { stars: number; comment: string; date: string }[];
};
export type OwnReview = {
  eligible: boolean;
  stars?: number | null;
  comment?: string | null;
};
