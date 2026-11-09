const baseUrl = import.meta.env?.BASE_URL ?? "/";
const coinUrl = `${baseUrl}kerdos-owl-coin.svg`;
const reverseCoinUrl = `${baseUrl}kerdos-owl-coin-reverse.svg`;

export function BrandCoin({size = 24, className, reverse = false}) {
  return <img src={reverse ? reverseCoinUrl : coinUrl} alt="" width={size} height={size} className={className} />;
}

export function BrandLogo() {
  return (
    <div className="kerdos-full-logo">
      <img src={`${coinUrl}#logo`} alt="KERDOS · A smarter way to purchase" />
    </div>
  );
}
