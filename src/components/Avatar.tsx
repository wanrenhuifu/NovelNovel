import { useEffect, useState } from "react";
import { User } from "lucide-react";

interface Props {
  blob: Blob | null | undefined;
  size?: number;
  className?: string;
}

export function Avatar({ blob, size = 40, className = "" }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  if (!url) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg bg-ink-700 text-ink-300 ${className}`}
        style={{ width: size, height: size }}
      >
        <User size={size * 0.5} />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className={`shrink-0 rounded-lg object-cover ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
