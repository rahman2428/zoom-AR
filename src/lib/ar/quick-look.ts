export function openQuickLook(assetUrl: string, title: string) {
  if (typeof document === "undefined") {
    return false;
  }

  const link = document.createElement("a");
  const image = document.createElement("img");
  const resolvedAssetUrl = new URL(assetUrl, window.location.href);

  link.rel = "ar";
  // Enable native pinch scaling in iOS Quick Look.
  link.href = `${resolvedAssetUrl.toString()}#allowsContentScaling=1`;
  link.appendChild(image);
  image.alt = `${title} AR preview`;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  return true;
}
