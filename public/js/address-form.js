// The Store's address form (views/partials/address-form.ejs): fills the linked
// Region -> Province -> City/Municipality -> Barangay dropdowns from the PSA's
// PSGC list (/api/store/psgc/...), one level at a time, and collects the form
// into the object the server expects. Metro Manila has no provinces; its
// province box then offers a single "Metro Manila (no province)" choice.
//
// window.AddressForm.init(element)        -> Promise, fills the dropdowns
// window.AddressForm.read(element)        -> the address as an object
// element.addEventListener('regionchange') fires with detail.regionCode
(function () {
  const cache = new Map();
  async function get(url) {
    if (!cache.has(url)) cache.set(url, apiFetch(url).then((r) => r.data));
    return cache.get(url);
  }
  function fill(select, items, placeholder, selected) {
    select.innerHTML = `<option value="">${placeholder}</option>`;
    items.forEach((it) => {
      const o = document.createElement('option');
      o.value = it.code;
      o.textContent = it.name;
      if (selected && it.code === selected) o.selected = true;
      select.appendChild(o);
    });
    select.disabled = items.length === 0;
  }
  const NO_PROVINCE = '__none';

  async function init(root) {
    const sel = (level) => root.querySelector(`[data-level="${level}"]`);
    const region = sel('region'); const province = sel('province'); const city = sel('city'); const bgy = sel('barangay');
    const start = { ...root.dataset };

    async function loadCities(selectedCity) {
      const regionCode = region.value;
      const prov = province.value === NO_PROVINCE ? '' : province.value;
      fill(city, [], 'Loading…'); fill(bgy, [], 'Choose a city first');
      if (!regionCode || !province.value) { fill(city, [], 'Choose a province first'); return; }
      const data = await get(`/api/store/psgc/cities?region=${regionCode}&province=${prov}`);
      fill(city, data.cities, 'Choose a city or municipality', selectedCity);
      if (selectedCity) await loadBarangays(start.barangay);
    }
    async function loadBarangays(selectedBgy) {
      fill(bgy, [], 'Loading…');
      if (!city.value) { fill(bgy, [], 'Choose a city first'); return; }
      const data = await get(`/api/store/psgc/barangays?city=${city.value}`);
      fill(bgy, data.barangays, 'Choose a barangay', selectedBgy);
    }
    async function loadProvinces(selectedProvince, selectedCity) {
      fill(province, [], 'Loading…'); fill(city, [], 'Choose a province first'); fill(bgy, [], 'Choose a city first');
      if (!region.value) { fill(province, [], 'Choose a region first'); return; }
      const data = await get(`/api/store/psgc/provinces?region=${region.value}`);
      const items = data.provinces.slice();
      if (data.directCities) items.unshift({ code: NO_PROVINCE, name: data.provinces.length ? 'Cities with no province' : 'Metro Manila (no province)' });
      fill(province, items, 'Choose a province', selectedProvince || (data.directCities && !data.provinces.length ? NO_PROVINCE : ''));
      if (province.value) await loadCities(selectedCity);
    }

    region.addEventListener('change', () => {
      loadProvinces();
      root.dispatchEvent(new CustomEvent('regionchange', { detail: { regionCode: region.value } }));
    });
    province.addEventListener('change', () => loadCities());
    city.addEventListener('change', () => loadBarangays());

    try {
      const data = await get('/api/store/psgc/regions');
      fill(region, data.regions, 'Choose a region', start.region);
      if (start.region) {
        await loadProvinces(start.province || (start.region ? NO_PROVINCE : ''), start.city);
        root.dispatchEvent(new CustomEvent('regionchange', { detail: { regionCode: region.value } }));
      }
    } catch (err) {
      fill(region, [], 'Could not load the list. Reload the page.');
    }
  }

  function read(root) {
    const out = {};
    root.querySelectorAll('input[name], select[name]').forEach((el) => { out[el.name] = el.value; });
    if (out.provinceCode === NO_PROVINCE) out.provinceCode = '';
    return out;
  }

  window.AddressForm = { init, read };
}());
