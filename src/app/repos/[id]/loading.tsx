import { PageHeaderSkeleton, Skeleton, StatRowSkeleton } from "@/components/ui/skeleton";

export default function RepoDetailLoading() {
  return (
    <div>
      <PageHeaderSkeleton breadcrumb />
      <StatRowSkeleton className="mb-6" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-80 rounded-xl" />
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
