import { PageHeaderSkeleton, Skeleton, StatRowSkeleton } from "@/components/ui/skeleton";

export default function JobDetailLoading() {
  return (
    <div className="space-y-5">
      <PageHeaderSkeleton breadcrumb />
      <StatRowSkeleton count={6} />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}
