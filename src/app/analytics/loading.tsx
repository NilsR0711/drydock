import {
  CardSkeleton,
  PageHeaderSkeleton,
  Skeleton,
  StatRowSkeleton,
} from "@/components/ui/skeleton";

export default function AnalyticsLoading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <Skeleton className="mb-4 h-9 w-64 rounded-lg" />
      <StatRowSkeleton className="mb-6" />
      <div className="grid gap-6 lg:grid-cols-3">
        <CardSkeleton className="lg:col-span-2" lines={[90, 75, 60]} />
        <CardSkeleton lines={[85, 70, 55]} />
      </div>
    </div>
  );
}
