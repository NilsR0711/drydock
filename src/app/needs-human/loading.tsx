import { PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function NeedsHumanLoading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
