import { CardSkeleton, PageHeaderSkeleton } from "@/components/ui/skeleton";

export default function AdrsLoading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <CardSkeleton lines={[90, 80, 70, 60, 50]} />
    </div>
  );
}
