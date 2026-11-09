const coinUrl = `${import.meta.env?.BASE_URL ?? "/"}kerdos-owl-coin.svg`;

export function BrandCoin({size = 24, className}) {
  return <img src={coinUrl} alt="" width={size} height={size} className={className} />;
}

export function BrandLogo() {
  return (
    <div className="kerdos-full-logo">
      <img src={`${coinUrl}#logo`} alt="KERDOS · A smarter way to purchase" />
    </div>
  );
}
