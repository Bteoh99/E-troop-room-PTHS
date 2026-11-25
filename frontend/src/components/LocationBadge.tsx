import { describeLocation } from '../lib/location';

interface Props {
  locationCode: string | null;
  rack: string | null;
  shelf: string | null;
  bin: number | null;
  size?: 'md' | 'lg' | 'xl';
  /** Show the "Rack 03 · Shelf B · Bin 2" helper line under the code. */
  showDescription?: boolean;
}

/** The hero of every result: a big, readable rack coordinate. */
export function LocationBadge({ locationCode, rack, shelf, bin, size = 'lg', showDescription = false }: Props) {
  const description = describeLocation({ rack, shelf, bin });

  if (!locationCode) {
    return (
      <span className={`loc-badge loc-badge--${size} loc-badge--none`} data-testid="location-badge-none">
        <span className="visually-hidden">Location: </span>
        No location yet
      </span>
    );
  }

  const unparsed = !rack;
  return (
    <span className="loc-badge-wrap">
      <span
        className={`loc-badge loc-badge--${size}${unparsed ? ' loc-badge--unparsed' : ''}`}
        data-testid="location-badge"
      >
        <span className="loc-badge__pin" aria-hidden="true">
          📍
        </span>
        <span className="visually-hidden">Location: </span>
        <span className="loc-badge__code">{locationCode}</span>
      </span>
      {showDescription && (
        <span className="loc-badge__desc">{description ?? 'Not a rack coordinate, so it is not shown on the map'}</span>
      )}
    </span>
  );
}
