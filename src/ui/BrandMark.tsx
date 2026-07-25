/** WeatherTS mark — the project's "WE" logo (bundled PNG). */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <img
      src="./logo.png"
      width={size}
      height={Math.round((size * 957) / 1220)}
      alt="WeatherTS"
      style={{ display: "block", objectFit: "contain" }}
      draggable={false}
    />
  );
}
