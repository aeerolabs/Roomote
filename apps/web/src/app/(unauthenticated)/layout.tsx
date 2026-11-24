'use client';

import { FramedSurface } from '@/components/layout';

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <FramedSurface
      variant="bold"
      frameClassName="h-[calc(var(--effective-viewport-height)-0.25rem)] w-[calc(100svw-0.25rem)] scroll-minimal overflow-hidden"
      surfaceClassName="light flex flex-col !overflow-y-auto !overflow-x-hidden text-foreground md:items-center"
      style={{
        height: 'var(--effective-viewport-height)',
        minHeight: 'var(--effective-viewport-height)',
      }}
    >
      <div className="relative flex w-full max-w-3xl flex-col md:min-h-full">
        <div className="pointer-events-none absolute inset-y-0 left-0 hidden border-black border-l-2 border-dotted md:block" />
        <div className="flex w-full flex-col px-4 py-6 space-y-4 md:my-auto md:px-0 md:py-10 md:pl-6">
          <div className="mb-8 flex w-fit shrink-0 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- small static mark on the sign-in screen */}
            <img
              src="/kojo-the-coder.png"
              alt=""
              width={56}
              height={56}
              className="size-14 rounded-full border-2 border-black bg-white object-cover"
            />
            <span className="text-3xl font-bold tracking-tighter">
              Kojo The Coder
            </span>
          </div>
          {children}
        </div>
      </div>
    </FramedSurface>
  );
}
