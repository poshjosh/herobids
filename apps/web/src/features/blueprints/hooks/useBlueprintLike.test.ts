import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (vi.hoisted for ESM safety — runs before imports) ────────────────

const { mockLike, mockUnlike } = vi.hoisted(() => ({
  mockLike: vi.fn<[string], Promise<{ liked: boolean; likeCount: number }>>(),
  mockUnlike: vi.fn<[string], Promise<{ liked: boolean; likeCount: number }>>(),
}));

vi.mock('../../../lib/api-client.js', () => ({
  blueprints: {
    like: mockLike,
    unlike: mockUnlike,
  },
}));

// Captures the last mutation config passed to useMutation so we can inspect
// mutationFn, onMutate, onSuccess, onError.
let lastMutationConfig: {
  mutationFn: () => Promise<unknown>;
  onMutate?: () => Promise<unknown>;
  onSuccess?: (data: unknown) => void;
  onError?: (error: unknown, variables: unknown, context: unknown) => void;
} | null = null;

const mockMutate = vi.fn();
const mockSetQueryData = vi.fn();
const mockCancelQueries = vi.fn();
const mockGetQueryData = vi.fn();
const mockInvalidateQueries = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: vi.fn((config: typeof lastMutationConfig) => {
    lastMutationConfig = config;
    return { mutate: mockMutate, isPending: false, error: null };
  }),
  useQueryClient: vi.fn(() => ({
    setQueryData: mockSetQueryData,
    cancelQueries: mockCancelQueries,
    getQueryData: mockGetQueryData,
    invalidateQueries: mockInvalidateQueries,
  })),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { useBlueprintLike } from './useBlueprintLike.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetMocks() {
  vi.clearAllMocks();
  lastMutationConfig = null;
  mockLike.mockResolvedValue({ liked: true, likeCount: 5 });
  mockUnlike.mockResolvedValue({ liked: false, likeCount: 4 });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('useBlueprintLike', () => {
  beforeEach(resetMocks);

  describe('mutationFn — direction', () => {
    it('calls blueprints.unlike when isLikedByViewer is true', async () => {
      const result = useBlueprintLike('bp-abc', true);

      expect(lastMutationConfig).not.toBeNull();
      const data = await lastMutationConfig!.mutationFn();
      expect(mockUnlike).toHaveBeenCalledWith('bp-abc');
      expect(mockLike).not.toHaveBeenCalled();
      expect(data).toEqual({ liked: false, likeCount: 4 });
      // toggle() wraps mutation.mutate — calling it should invoke the mock
      result.toggle();
      expect(mockMutate).toHaveBeenCalled();
    });

    it('calls blueprints.like when isLikedByViewer is false', async () => {
      useBlueprintLike('bp-abc', false);

      expect(lastMutationConfig).not.toBeNull();
      const data = await lastMutationConfig!.mutationFn();
      expect(mockLike).toHaveBeenCalledWith('bp-abc');
      expect(mockUnlike).not.toHaveBeenCalled();
      expect(data).toEqual({ liked: true, likeCount: 5 });
    });
  });

  describe('return shape', () => {
    it('exposes toggle, isPending, and error', () => {
      const result = useBlueprintLike('bp-xyz', false);

      expect(result.toggle).toBeDefined();
      expect(typeof result.toggle).toBe('function');
      expect(result.isPending).toBe(false);
      expect(result.error).toBeNull();
    });
  });

  describe('onSuccess — cache patching', () => {
    it('patches detail cache with authoritative server response on success', () => {
      useBlueprintLike('bp-abc', false);

      expect(lastMutationConfig).not.toBeNull();
      const { onSuccess } = lastMutationConfig!;
      expect(onSuccess).toBeDefined();

      // Simulate a successful like response
      onSuccess!({ liked: true, likeCount: 5 });

      // Should call setQueryData with an updater function
      expect(mockSetQueryData).toHaveBeenCalledWith(
        ['blueprints', 'bp-abc'],
        expect.any(Function),
      );

      // And invalidate browse queries in background
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ['blueprints', 'browse'],
        refetchType: 'active',
      });
    });

    it('preserves old data when patching detail cache on unlike', () => {
      useBlueprintLike('bp-abc', true);

      const { onSuccess } = lastMutationConfig!;

      onSuccess!({ liked: false, likeCount: 4 });

      expect(mockSetQueryData).toHaveBeenCalledWith(
        ['blueprints', 'bp-abc'],
        expect.any(Function),
      );
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ['blueprints', 'browse'],
        refetchType: 'active',
      });
    });
  });

  describe('onMutate — optimistic update', () => {
    it('cancels ongoing queries and applies optimistic update', async () => {
      // Set up getQueryData to return a mock detail
      const mockDetail = {
        id: 'bp-abc',
        isLikedByViewer: false,
        likeCount: 3,
      };
      mockGetQueryData.mockReturnValue(mockDetail);

      useBlueprintLike('bp-abc', false);

      expect(lastMutationConfig).not.toBeNull();
      const { onMutate } = lastMutationConfig!;
      expect(onMutate).toBeDefined();

      await onMutate!();

      expect(mockCancelQueries).toHaveBeenCalledWith({
        queryKey: ['blueprints', 'bp-abc'],
      });

      // Optimistic update: flip isLikedByViewer and increment likeCount
      expect(mockSetQueryData).toHaveBeenCalledWith(
        ['blueprints', 'bp-abc'],
        expect.objectContaining({
          isLikedByViewer: true,
          likeCount: 4,
        }),
      );
    });

    it('optimistic unlike decrements likeCount', async () => {
      const mockDetail = {
        id: 'bp-abc',
        isLikedByViewer: true,
        likeCount: 5,
      };
      mockGetQueryData.mockReturnValue(mockDetail);

      useBlueprintLike('bp-abc', true);

      const { onMutate } = lastMutationConfig!;
      await onMutate!();

      expect(mockSetQueryData).toHaveBeenCalledWith(
        ['blueprints', 'bp-abc'],
        expect.objectContaining({
          isLikedByViewer: false,
          likeCount: 4,
        }),
      );
    });

    it('skips optimistic update when no previous detail is cached', async () => {
      mockGetQueryData.mockReturnValue(undefined);

      useBlueprintLike('bp-abc', false);

      const { onMutate } = lastMutationConfig!;
      const context = await onMutate!();

      // setQueryData should not be called because there was no previous detail
      expect(mockSetQueryData).not.toHaveBeenCalled();
      expect(context).toEqual({ previousDetail: undefined });
    });
  });

  describe('onError — rollback', () => {
    it('rolls back to previous detail on error', () => {
      const previousDetail = {
        id: 'bp-abc',
        isLikedByViewer: false,
        likeCount: 3,
      };

      useBlueprintLike('bp-abc', false);

      const { onError } = lastMutationConfig!;
      expect(onError).toBeDefined();

      onError!(new Error('network error'), undefined, { previousDetail });

      expect(mockSetQueryData).toHaveBeenCalledWith(
        ['blueprints', 'bp-abc'],
        previousDetail,
      );
    });

    it('does not attempt rollback when context has no previous detail', () => {
      useBlueprintLike('bp-abc', false);

      const { onError } = lastMutationConfig!;
      onError!(new Error('network error'), undefined, undefined);

      // setQueryData should only have been called for optimistic update (onMutate runs first)
      // In this test onMutate wasn't called, so no setQueryData calls at all
      expect(mockSetQueryData).not.toHaveBeenCalled();
    });
  });
});
