import { useState, type ReactNode } from 'react';

import { Button, type BUTTON_VARIANT } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Button for affordances with no API backing yet: opens a "Coming at the
 * hackathon" dialog instead of acting (same pattern as Promote to Look).
 */
export function ComingSoonButton({
  children,
  title,
  description,
  variant = 'primary',
}: {
  children: ReactNode;
  title: string;
  description: string;
  variant?: keyof typeof BUTTON_VARIANT;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>Coming at the hackathon: {description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
