import { CardSkeleton, PageHeaderSkeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4">
        <CardSkeleton lines={[80, 65, 50]} />
        <CardSkeleton lines={[80, 65]} />
      </div>
    </div>
  );
}
