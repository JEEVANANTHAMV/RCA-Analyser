import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea"> & { autoResize?: boolean }>(
  ({ className, autoResize, ...props }, forwardedRef) => {
    const localRef = React.useRef<HTMLTextAreaElement>(null);

    const setRef = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        (localRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      },
      [forwardedRef],
    );

    React.useLayoutEffect(() => {
      if (autoResize && localRef.current) {
        const el = localRef.current;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }
    });

    return (
      <textarea
        className={cn(
          "flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          autoResize && "overflow-y-hidden resize-none",
          className,
        )}
        ref={setRef}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
