import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { attachEditHandlers, collectContent } from '../lib/collectContent';
import { Alert, LoadingBlock } from './ui';

export interface ReportDocumentHandle {
  getContent(base?: Record<string, unknown>): Record<string, unknown>;
  print(): void;
}

interface Props {
  reportId: string;
  docKey: string;
  mode: 'edit' | 'print';
  onDirty?: () => void;
}

/**
 * Renders the server-produced report HTML in a same-origin, script-free
 * iframe. Edit mode writes `contenteditable` values back through
 * collectContent; print mode only displays the fixed letterhead document.
 */
export const ReportDocumentFrame = forwardRef<ReportDocumentHandle, Props>(
  function ReportDocumentFrame({ reportId, docKey, mode, onDirty }, ref) {
    const frame = useRef<HTMLIFrameElement | null>(null);
    const cleanup = useRef<(() => void) | null>(null);
    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [height, setHeight] = useState(1100);

    useEffect(() => {
      let cancelled = false;
      setHtml(null);
      setError(null);
      api
        .get<string>(`/reports/${reportId}/document`, {
          params: { mode },
          responseType: 'text',
          transformResponse: (raw) => raw,
        })
        .then((res) => !cancelled && setHtml(res.data))
        .catch((err) => !cancelled && setError(errorMessage(err)));
      return () => {
        cancelled = true;
      };
    }, [reportId, docKey, mode]);

    useEffect(() => () => cleanup.current?.(), []);

    function onLoad() {
      cleanup.current?.();
      const doc = frame.current?.contentDocument;
      if (!doc) return;
      const resize = () => setHeight(doc.documentElement.scrollHeight + 8);
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(doc.body);
      const detach =
        mode === 'edit'
          ? attachEditHandlers(doc, () => {
              onDirty?.();
              resize();
            })
          : () => undefined;
      cleanup.current = () => {
        observer.disconnect();
        detach();
      };
    }

    useImperativeHandle(
      ref,
      () => ({
        getContent: (base = {}) => {
          const doc = frame.current?.contentDocument;
          return doc ? collectContent(doc, base) : base;
        },
        print: () => frame.current?.contentWindow?.print(),
      }),
      [],
    );

    if (error) return <Alert tone="danger">{error}</Alert>;
    if (html === null) return <LoadingBlock label="Preparing the report…" />;
    return (
      <iframe
        ref={frame}
        title="Report"
        srcDoc={html}
        onLoad={onLoad}
        sandbox="allow-same-origin allow-modals"
        style={{ height }}
        className="mx-auto block w-[8.5in] max-w-full border-0 bg-white"
      />
    );
  },
);
