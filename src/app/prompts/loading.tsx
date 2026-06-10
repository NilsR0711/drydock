import { CardSkeleton, PageHeaderSkeleton } from "@/components/ui/skeleton";

export default function PromptsLoading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <CardSkeleton lines={[90, 75, 60, 45]} />
    </div>
  );
}
