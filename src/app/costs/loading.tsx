import { CardSkeleton, PageHeaderSkeleton } from "@/components/ui/skeleton";

export default function CostsLoading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="grid gap-6 lg:grid-cols-3">
        <CardSkeleton className="h-72" lines={[60, 45]} />
        <CardSkeleton className="h-72" lines={[85, 70, 55, 40]} />
        <CardSkeleton className="h-72" lines={[85, 70, 55, 40]} />
      </div>
    </div>
  );
}
