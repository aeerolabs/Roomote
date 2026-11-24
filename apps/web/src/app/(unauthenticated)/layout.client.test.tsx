import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const { framedSurfaceMock } = vi.hoisted(() => ({
  framedSurfaceMock: vi.fn(
    ({
      children,
      frameClassName,
      surfaceClassName,
      variant,
      style,
    }: {
      children: ReactNode;
      frameClassName?: string;
      surfaceClassName?: string;
      variant?: string;
      style?: React.CSSProperties;
    }) => (
      <div
        data-frame-class-name={frameClassName}
        data-surface-class-name={surfaceClassName}
        data-variant={variant}
        data-height={style?.height}
        data-min-height={style?.minHeight}
      >
        {children}
      </div>
    ),
  ),
}));

vi.mock('@/components/layout', () => ({
  FramedSurface: framedSurfaceMock,
}));

import Layout from './layout';

describe('Unauthenticated layout', () => {
  beforeEach(() => {
    framedSurfaceMock.mockClear();
  });

  it('renders the logged-out shell in the setup-style centered frame', () => {
    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(screen.getByText('Kojo The Coder')).toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();

    expect(framedSurfaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'bold',
        frameClassName: expect.stringContaining(
          'h-[calc(var(--effective-viewport-height)-0.25rem)]',
        ),
        surfaceClassName: expect.stringContaining(
          'light flex flex-col !overflow-y-auto !overflow-x-hidden text-foreground md:items-center',
        ),
        style: expect.objectContaining({
          height: 'var(--effective-viewport-height)',
          minHeight: 'var(--effective-viewport-height)',
        }),
      }),
      undefined,
    );
    const contentColumn =
      screen.getByText('Kojo The Coder').parentElement?.parentElement;
    expect(contentColumn).toHaveClass(
      'flex',
      'w-full',
      'flex-col',
      'md:my-auto',
    );

    const centeredShell = contentColumn?.parentElement;
    expect(centeredShell).toHaveClass('relative', 'max-w-3xl', 'md:min-h-full');
    expect(centeredShell?.firstElementChild).toHaveClass(
      'absolute',
      'inset-y-0',
      'left-0',
      'border-l-2',
      'border-dotted',
    );
    expect(screen.getByText('Kojo The Coder').parentElement).toHaveClass(
      'mb-8',
    );
  });
});
