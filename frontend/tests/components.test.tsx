import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routerFuture } from '../src/App';
import type { Condition } from '../src/api/types';
import { ConditionChip } from '../src/components/ConditionChip';
import { LocationBadge } from '../src/components/LocationBadge';
import { RackDiagram } from '../src/components/RackDiagram';
import { StoreMap } from '../src/components/StoreMap';
import { CONDITION_SYMBOLS, conditionLabel } from '../src/lib/conditions';
import { describeLocation, shelfRange } from '../src/lib/location';

describe('ConditionChip', () => {
  it.each<[Condition, string, string]>([
    ['good', 'Good', '✓'],
    ['needs_repair', 'Needs repair', '!'],
    ['damaged', 'Damaged', '✕'],
    ['written_off', 'Written off', '–'],
  ])('%s shows text + symbol, not colour alone', (condition, label, symbol) => {
    const { container } = render(<ConditionChip condition={condition} />);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip).toHaveClass(`chip--${condition}`);
    expect(chip).toHaveTextContent(`${symbol}Condition: ${label}`);
    expect(CONDITION_SYMBOLS[condition]).toBe(symbol);
  });

  it('conditionLabel falls back gracefully', () => {
    expect(conditionLabel('weird')).toBe('weird');
    expect(conditionLabel(null)).toBe('Unknown');
  });
});

describe('LocationBadge', () => {
  it('shows pin + code and a readable description', () => {
    render(<LocationBadge locationCode="R03-B-2" rack="R03" shelf="B" bin={2} showDescription />);
    const badge = screen.getByTestId('location-badge');
    expect(badge).toHaveTextContent('📍Location: R03-B-2');
    expect(badge).not.toHaveClass('loc-badge--unparsed');
    expect(screen.getByText('Rack 03 · Shelf B · Bin 2')).toBeInTheDocument();
  });

  it('marks a non-coordinate location as unparsed', () => {
    render(<LocationBadge locationCode="loft" rack={null} shelf={null} bin={null} showDescription />);
    expect(screen.getByTestId('location-badge')).toHaveClass('loc-badge--unparsed');
    expect(screen.getByText(/Not a rack coordinate/)).toBeInTheDocument();
  });

  it('shows "No location yet" for null', () => {
    render(<LocationBadge locationCode={null} rack={null} shelf={null} bin={null} />);
    expect(screen.getByText(/No location yet/)).toBeInTheDocument();
  });
});

describe('RackDiagram', () => {
  it('draws shelves A..last from top with at least 3 bins, highlighting one bin', () => {
    render(
      <RackDiagram
        rack="R02"
        items={[
          { id: 1, shelf: 'A', bin: 1 },
          { id: 2, shelf: 'C', bin: 2 },
        ]}
        highlightShelf="C"
        highlightBin={2}
      />,
    );
    const d = screen.getByTestId('rack-diagram');
    expect([...d.querySelectorAll('[data-shelf]')].map((e) => e.getAttribute('data-shelf'))).toEqual(['A', 'B', 'C']);
    expect(d.querySelectorAll('[data-shelf="B"] [data-bin]')).toHaveLength(3);
    const hit = d.querySelector('[data-highlighted="true"]') as HTMLElement;
    expect(hit.getAttribute('data-bin')).toBe('2');
    expect(hit.closest('[data-shelf]')?.getAttribute('data-shelf')).toBe('C');
    expect(within(d).getByText('Rack R02 has 3 shelf levels, A at the top. Highlighted: shelf C, bin 2.')).toBeInTheDocument();
  });

  it('grows to fit a highlighted bin beyond the known items and a highlighted shelf beyond known shelves', () => {
    render(<RackDiagram rack="R01" items={[]} shelves={['A']} highlightShelf="D" highlightBin={7} />);
    const d = screen.getByTestId('rack-diagram');
    expect(d.querySelectorAll('[data-shelf]')).toHaveLength(4);
    expect(d.querySelectorAll('[data-shelf="A"] [data-bin]')).toHaveLength(7);
    expect(d.querySelector('[data-shelf="D"] [data-bin="7"]')).toHaveAttribute('data-highlighted', 'true');
  });

  it('defaults to a single shelf A with no highlight', () => {
    render(<RackDiagram rack="R01" items={[]} />);
    const d = screen.getByTestId('rack-diagram');
    expect(d.querySelectorAll('[data-shelf]')).toHaveLength(1);
    expect(d.querySelectorAll('[data-highlighted]')).toHaveLength(0);
  });
});

describe('StoreMap', () => {
  const racks = [
    { rack: 'R01', shelves: ['B', 'A'], itemCount: 2 },
    { rack: 'R02', shelves: [], itemCount: 0 },
  ];

  it('renders tiles, highlights the requested rack with text, can render non-link tiles', () => {
    const { rerender } = render(
      <MemoryRouter future={routerFuture}>
        <StoreMap racks={racks} highlightRack="R02" />
      </MemoryRouter>,
    );
    const map = screen.getByTestId('store-map');
    expect(within(map).getByRole('link', { name: 'Rack R01, 2 items' })).toHaveTextContent('Shelves A–B');
    expect(within(map).getByRole('link', { name: 'Rack R02, 0 items, this item is here' })).toHaveTextContent(
      'No shelves yet',
    );
    expect(map.querySelector('[data-rack="R02"]')).toHaveAttribute('data-highlighted', 'true');
    rerender(
      <MemoryRouter future={routerFuture}>
        <StoreMap racks={racks} linkTiles={false} />
      </MemoryRouter>,
    );
    expect(within(screen.getByTestId('store-map')).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('location helpers', () => {
  it('describeLocation', () => {
    expect(describeLocation({ rack: 'R03', shelf: 'B', bin: 2 })).toBe('Rack 03 · Shelf B · Bin 2');
    expect(describeLocation({ rack: 'R03', shelf: null, bin: null })).toBe('Rack 03');
    expect(describeLocation({ rack: null, shelf: null, bin: null })).toBeNull();
  });
  it('shelfRange', () => {
    expect(shelfRange('c')).toEqual(['A', 'B', 'C']);
    expect(shelfRange('')).toEqual([]);
    expect(shelfRange('1')).toEqual([]);
  });
});
