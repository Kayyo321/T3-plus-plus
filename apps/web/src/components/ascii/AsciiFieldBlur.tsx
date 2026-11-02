import { useEffect, useRef } from "react";

import { shadeAsciiFieldBlur } from "./asciiFieldBlur";
import type { AsciiShaderEngine } from "./asciiShaderEngine";

/**
 * The landing shader, blurred, for a surface too opaque to see the real canvas through. It reads
 * the running field instead of opening a second WebGL context, and burns out with it.
 */
export function AsciiFieldBlur(props: { readonly shader: AsciiShaderEngine }) {
  const { shader } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints a canvas from a WebGL field, which lives outside React
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let image: ImageData | null = null;
    shader.setTap({
      element: canvas,
      onFrame: (frame) => {
        if (image?.width !== frame.columns || image.height !== frame.rows) {
          canvas.width = frame.columns;
          canvas.height = frame.rows;
          image = context.createImageData(frame.columns, frame.rows);
        }
        shadeAsciiFieldBlur(frame, image.data);
        context.putImageData(image, 0, 0);
      },
    });
    return () => shader.setTap(null);
  }, [shader]);

  // Overhangs its parent so the sides clip flat, and the mask feathers the top and bottom.
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute -start-4 -top-4 h-[calc(100%+2rem)] w-[calc(100%+2rem)] blur-md [mask-image:linear-gradient(to_bottom,transparent_1rem,black_3rem,black_calc(100%-3rem),transparent_calc(100%-1rem))]"
    />
  );
}
