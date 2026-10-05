'use client';

import Link from 'next/link';
import { useState } from 'react';
import { groupPath } from '@/lib/links';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

export interface NavGroup {
  id: string;
  name: string;
}

/** A direct group link for one membership, or a chooser for several. */
export function NavGroups({
  groups,
  className = '',
  onNavigate,
}: {
  groups: NavGroup[];
  className?: string;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (groups.length === 0) return null;
  if (groups.length === 1) {
    return (
      <Link href={groupPath(groups[0].id)} className={className} onClick={onNavigate}>
        group
      </Link>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={`cursor-pointer hover:underline ${className}`} aria-label="Choose a reading group">
        groups
      </PopoverTrigger>
      <PopoverContent menu align="end" className="max-w-64">
        {groups.map((group) => (
          <Link
            key={group.id}
            href={groupPath(group.id)}
            className="py-1 break-words narrow:min-h-11 narrow:py-2"
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
          >
            {group.name}
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  );
}
