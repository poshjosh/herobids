import { useMutation, useQueryClient } from '@tanstack/react-query';
import { blueprints, type BlueprintDetail } from '../../../lib/api-client.js';

/**
 * Hook for toggling a like/unlike on a blueprint.
 *
 * Performs an optimistic cache update so the UI responds instantly,
 * patches the detail cache with the authoritative server response on success,
 * and rolls back on error.
 */
export function useBlueprintLike(blueprintId: string, isLikedByViewer: boolean) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      isLikedByViewer ? blueprints.unlike(blueprintId) : blueprints.like(blueprintId),

    onMutate: async () => {
      // Cancel ongoing queries to prevent them overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: ['blueprints', blueprintId] });

      // Snapshot previous detail for rollback
      const previousDetail = queryClient.getQueryData<BlueprintDetail>(['blueprints', blueprintId]);

      // Optimistically update the detail cache
      if (previousDetail) {
        queryClient.setQueryData<BlueprintDetail>(['blueprints', blueprintId], {
          ...previousDetail,
          isLikedByViewer: !isLikedByViewer,
          likeCount: isLikedByViewer
            ? previousDetail.likeCount - 1
            : previousDetail.likeCount + 1,
        });
      }

      // Return rollback context
      return { previousDetail };
    },

    onSuccess: (data) => {
      // Patch detail cache with authoritative server response
      queryClient.setQueryData<BlueprintDetail>(
        ['blueprints', blueprintId],
        (old) => {
          if (!old) return old;
          return { ...old, likeCount: data.likeCount, isLikedByViewer: data.liked };
        },
      );

      // Invalidate browse queries in background for consistency
      void queryClient.invalidateQueries({
        queryKey: ['blueprints', 'browse'],
        refetchType: 'active',
      });
    },

    onError: (_error, _variables, context) => {
      // Rollback to previous state on error
      if (context?.previousDetail) {
        queryClient.setQueryData(['blueprints', blueprintId], context.previousDetail);
      }
    },
  });

  return {
    toggle: () => mutation.mutate(),
    isPending: mutation.isPending,
    error: mutation.error,
  };
}
