import { ListSkeleton, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function JobsLoading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <Skeleton className="mb-4 h-9 rounded-lg" />
      <div className="rounded-xl border border-card-border bg-card p-4 shadow-sm">
        <ListSkeleton rows={10} />
      </div>
    </div>
  );
}
