// The page shows no scrollbars; its edges say where more is. The bar frosts
// once the page has moved under it, and the bottom edge blurs while there is
// more below.
const bar = document.querySelector(".bar");
const edge = document.querySelector(".edge");

function update() {
  const top = window.scrollY;
  const below = document.documentElement.scrollHeight - window.innerHeight - top;
  bar?.classList.toggle("is-over", top > 4);
  edge?.classList.toggle("is-on", below > 24);
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    update();
  });
}

addEventListener("scroll", schedule, { passive: true });
addEventListener("resize", schedule);
document.addEventListener("toggle", schedule, true);
update();
