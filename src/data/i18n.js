import { I18N_VI } from './i18n_vi.js';
import { I18N_EN } from './i18n_en.js';

export const I18N = {
  vi: I18N_VI,
  en: I18N_EN,
};

const APPARATUS_USAGE_GUIDES = {
  colorimeter: {
    vi: '1) Kéo đầu dò vào dung dịch trong bình (hoặc kẹp lên Giá thí nghiệm).\n2) Ở bảng bên phải, chọn 3 chế độ:\n   • Động học A(t): Chọn bước sóng 420–635 nm để theo dõi độ hấp thụ A & %T theo thời gian thực.\n   • Quét UV–Vis (220–750 nm): Tự động tìm cực đại hấp thụ λ_max & phức chất màu.\n   • Phổ FT-IR (4000–400 cm⁻¹): Bật/tắt "Trừ nền H₂O" để soi các đỉnh nhóm chức O–H, C=O, N–H, C–O, C=C.\n3) Rê chuột trực tiếp lên đồ thị để đọc số sóng/bước sóng & gán nhóm chức chính xác.',
    en: '1) Drag the probe tip into any solution vessel (or clamp to a Retort Stand).\n2) Choose among 3 analytical modes in the right Inspector:\n   • Kinetics A(t): Select 420–635 nm to log real-time Beer–Lambert Absorbance & %T.\n   • UV–Vis Scan (220–750 nm): Automatically detects λ_max and chromophore peaks.\n   • FT-IR Scan (4000–400 cm⁻¹): Toggle "Subtract H₂O" to inspect O–H, C=O, N–H, C–O bands.\n3) Hover directly across the spectrum canvas to inspect exact wavenumber/wavelength & peak assignments.',
  },
  ph_conductometer: {
    vi: '1) Nhúng đầu dò điện cực kép xuống dung dịch (hoặc kẹp lên Giá thí nghiệm phía trên bình chuẩn độ).\n2) Đọc trực tiếp giá trị pH, độ dẫn điện σ (mS/cm) và nhiệt độ bù T.\n3) Khi kết hợp với Buret hoặc nhỏ dung dịch chuẩn độ, đồ thị đường cong chuẩn độ pH(ΔV) & độ dẫn σ(ΔV) tự động vẽ theo thời gian thực ở bảng bên phải.',
    en: '1) Dip the dual glass/Pt probe into a solution (or clamp onto a Retort Stand above a titration flask).\n2) Read live temperature-compensated pH and ionic conductivity σ (mS/cm).\n3) During titration from a Burette, real-time pH(ΔV) and conductivity σ(ΔV) curves plot automatically in the Inspector.',
  },
  tlc_plate: {
    vi: '1) Nhúng đầu dưới bản mỏng Silica gel F254 vào bình chứa dung môi pha động hữu cơ hoặc hỗn hợp phản ứng.\n2) Quan sát mặt dung môi (Solvent Front) dâng lên theo mao dẫn và tách các vết chất theo độ phân cực Rf.\n3) Bật đèn UV (254 nm) trên thanh công cụ để soi các vết hấp thụ UV phát sáng/tắt huỳnh quang; nhấn "Rửa bản mỏng" để tái sử dụng.',
    en: '1) Dip the bottom edge of the Silica gel 60 F254 plate into a vessel containing mobile-phase organic solvent/analyte.\n2) Watch capillary elution advance the solvent front and separate compounds by Rf.\n3) Toggle the UV Lamp (254 nm) in the top bar to reveal fluorescence-quenched spots; click Reset/Clean to reuse.',
  },
  dc_power: {
    vi: '1) Cắm 2 Điện cực vào dung dịch cần điện phân (hoặc pin điện hóa).\n2) Dùng nút "Nối (+) / Nối (-)" hoặc kéo dây nối cực dương (đỏ) và cực âm (đen) vào 2 điện cực.\n3) Chỉnh hiệu điện thế V (0–24 V) và biến trở R (Ω), sau đó bật Công tắc Nguồn để điện phân & theo dõi cường độ dòng I (A), mật độ dòng J (A/dm²).',
    en: '1) Dock two Electrodes into electrolyte solution(s).\n2) Connect the red (+) Anode and black (-) Cathode leads to the electrode terminals.\n3) Adjust voltage (0–24 V) and rheostat (Ω), then switch Power ON to drive electrolysis and monitor current I (A) and J (A/dm²).',
  },
  volt_ammeter: {
    vi: '1) Chọn chế độ Vôn kế (đo suất điện động pin điện E_pin) hoặc Ampe kế / Đoản mạch (đo dòng ăn mòn điện hóa).\n2) Nối dây dương/âm vào 2 điện cực trong 2 cốc có Cầu muối (hoặc cặp kim loại tiếp xúc).\n3) Đọc điện áp E (V), dòng điện I (A) và trạng thái bảo vệ catot (Cathodic Protection).',
    en: '1) Select Voltmeter (open-circuit cell EMF), Ammeter, or Short-circuit galvanic corrosion mode.\n2) Wire the positive & negative leads to two docked electrodes (linked by a Salt Bridge if in separate half-cells).\n3) Observe live potential (V), current (A), and sacrificial cathodic protection telemetry.',
  },
  scale: {
    vi: '1) Đặt Cốc/Bình hoặc chất rắn lên đĩa cân điện tử.\n2) Đọc khối lượng tổng chính xác đến 0.01 g trên màn hình LED và bảng bên phải.\n3) Nhấn "Trừ bì (Tare)" để đưa số đọc về 0.00 g trước khi cân thêm hóa chất mới.',
    en: '1) Place any vessel on the weighing pan.\n2) Read real-time mass to 0.01 g resolution on the LCD readout and Inspector.\n3) Press "Tare" to zero the current load before dosing reagents.',
  },
  gas_syringe: {
    vi: '1) Kéo thả nút nối trên Xi-lanh khí tới ống dẫn khí của bình kín để thu & đo thể tích khí (đến 100 mL) theo P, T.\n2) Có thể quan sát chất lỏng ngưng tụ/đóng băng bên trong khi làm lạnh.\n3) Dùng nút "Đẩy pít-tông" hoặc lăn chuột để bơm khí/lỏng sang bình khác hoặc sục bọt qua ống dẫn.',
    en: '1) Connect the Gas Syringe via gas tubing to a stoppered vessel to collect and meter gas up to 100 mL at real P & T.\n2) Observe condensed liquid or ice inside when cooled.\n3) Use "Hold to Push" or Mouse Wheel to eject gas/liquid parabolically into another vessel.',
  },
  separatory_funnel: {
    vi: '1) Khi mở nút nhám trên cổ phễu, có thể nghiêng bình đổ hỗn hợp 2 pha lỏng, kéo hóa chất hoặc hút/nhỏ bằng Pipette.\n2) Đậy nút nhám NS 19/26 trước khi bấm "Lắc chiết" (nếu quên đậy nút khi lắc sẽ bị văng/tràn!).\n3) Để yên tách lớp, kẹp lên Giá hoặc lắp thẳng xuống cổ bình cầu rồi mở khóa PTFE để xả riêng lớp dưới; có chế độ tự đóng đúng ranh giới pha.',
    en: '1) With the top stopper removed, pour immiscible liquid mixtures into the funnel (via tilt-pour, Dosing Modal, or Pipette).\n2) Seal the NS 19/26 Ground Stopper BEFORE clicking Shake (shaking unstoppered causes splashing/spillover!).\n3) Wait for phase settling, clamp or mount into a flask neck, and open the PTFE stopcock to drain the denser bottom layer cleanly.',
  },
  burette_50: {
    vi: '1) Kẹp Buret 50 mL lên Giá thí nghiệm phía trên bình hứng.\n2) Nạp dung dịch chuẩn (hỗn hợp hoặc dung dịch đơn) bằng nút nạp ở bảng phải, hộp thoại đong, Pipette hoặc rót nghiêng bình vào miệng Buret.\n3) Chọn tốc độ khóa vặn (mL/s) hoặc nhấn "+1 Giọt chuẩn (0.05 mL)" để chuẩn độ chính xác từng giọt; xem bảng thành phần lỏng ở cột phải.',
    en: '1) Clamp the 50 mL Burette onto a Retort Stand above your titration flask.\n2) Fill it with single reagents or mixed solutions via the Inspector fill tool, tilt-pouring, Dosing Modal, or Pipette.\n3) Set stopcock flow rate (mL/s) or click "+1 Drop (0.05 mL)" for dropwise titration; inspect held liquid species on the right.',
  },
  pipette_10: {
    vi: '1) Kéo thả Pipette vào bình, phễu chiết hoặc buret chứa chất lỏng để hút (tối đa 10 mL, giữ được hỗn hợp lỏng).\n2) Kéo thả sang bình khác để nhỏ theo liều đã chọn (0.05 mL – 10 mL).\n3) Mẹo nhanh: Di chuột tới Pipette trên miệng bình rồi Lăn lên để hút, Lăn xuống để nhỏ, hoặc Shift+Lăn để đổi liều giọt.',
    en: '1) Drag onto any wet vessel, funnel, or burette to draw up to 10 mL (preserves full liquid mixtures).\n2) Drag & release onto a target container to dispense the selected dose (0.05 – 10 mL).\n3) Shortcut: Hover Pipette over a vessel and Scroll Up to draw, Scroll Down to drip, or Shift+Scroll to change drop dose.',
  },
  liebig_condenser: {
    vi: '1) Gắn vào Giá thí nghiệm và nối ống dẫn hơi từ bình cầu đun sôi để ngưng tụ chưng cất sang bình hứng.\n2) Hoặc bật chế độ "Hồi lưu (Reflux)" để cắm thẳng đứng lên cổ bình cầu đun hồi lưu (tự trả chất lỏng ngưng tụ về bình, không thất thoát hơi).\n3) Điều chỉnh góc xoay và bật/tắt dòng nước làm mát.',
    en: '1) Clamp to a Stand and connect vapor tubing from a boiling flask to distill & condense distillate into a receiver.\n2) Or enable "Reflux Mode" to mount vertically on a flask neck so condensed vapors return continuously without escaping.\n3) Toggle cooling water flow and adjust angle.',
  },
  bunsen_burner: {
    vi: '1) Bật mức lửa 1–3; mở cửa gió (Air Hole) cho ngọn lửa xanh không muội (~1400–1600 °C) để nung gốm/đốt nhiệt cao.\n2) Đóng cửa gió tạo ngọn lửa vàng (~700–900 °C) dễ bám muội than dưới đáy bình.\n3) Đặt bình lên kiềng hoặc kẹp trên Giá phía trên đầu đốt.',
    en: '1) Set flame level 1–3; open the Air Hole for a hot non-luminous blue flame (~1400–1600 °C) for calcination & combustion.\n2) Close the air hole for a cooler luminous yellow flame (~700–900 °C) that deposits soot.\n3) Place vessels above the plume directly or on a Retort Stand.',
  },
  ice_bath: {
    vi: '1) Chọn chế độ Đá nước (0 °C), Đá–Muối (-10 °C), Nước nóng hoặc Bể dầu silicone (160–240 °C).\n2) Đặt cốc, bình cầu hoặc ống nghiệm vào bể để làm lạnh sâu (kết tinh, diazo hóa 0–5 °C) hoặc gia nhiệt đồng đều.\n3) Chú ý sốc nhiệt: không nhúng thủy tinh thường vừa nung >350 °C ngay vào bể đá!',
    en: '1) Select Ice Water (0 °C), Ice–Salt (-10 °C), Hot Water, or Silicone Oil Bath (160–240 °C).\n2) Place flasks/tubes inside for controlled cooling (diazotization 0–5 °C, crystallization) or even heating.\n3) Avoid thermal shock: never plunge >350 °C borosilicate glass straight into an ice bath!',
  },
  stir_bar: {
    vi: 'Thả con từ vào đáy bình có chất lỏng, rồi chỉnh tốc độ khuấy RPM ở bảng bên phải của bình để tăng tốc hòa tan, chiết pha và phân tán kết tủa.',
    en: 'Drop the PTFE magnetic stir bar into a vessel, then adjust stirring speed (RPM) in the vessel Inspector to speed up dissolution, mixing, and phase transfer.',
  },
  boiling_chips: {
    vi: 'Thả đá bọt xốp vào bình chất lỏng trước khi đun sôi mạnh để tạo mầm bọt đều, chống hiện tượng quá nhiệt / sôi trào đột ngột (bumping).',
    en: 'Add porous boiling chips before vigorous heating to provide nucleation sites and suppress violent superheating/bumping.',
  },
  electrode_rod: {
    vi: 'Kẹp vào thành cốc dung dịch, chọn vật liệu (Graphite C, Cu, Zn, Fe, Pt, Ag) ở bảng bên phải rồi nối với Nguồn DC hoặc Vôn/Ampe kế.',
    en: 'Dock onto a vessel rim, select electrode material (Graphite C, Cu, Zn, Fe, Pt, Ag) in the Inspector, then wire to DC Power Supply or Multimeter.',
  },
  salt_bridge: {
    vi: 'Đặt giữa 2 bình nửa pin điện hóa và chọn Bình A / Bình B để khép kín mạch ion KNO₃/KCl mà không trộn lẫn dung dịch 2 cốc. Cuộn chuột trực tiếp lên cầu muối để đổi nhanh 6 chất điện li.',
    en: 'Bridge two half-cell vessels and assign Vessel A / Vessel B to complete the ionic circuit via KNO₃/KCl without bulk mixing. Scroll mouse wheel over the bridge to cycle 6 electrolytes.',
  },
  electrophoresis_cell: {
    vi: 'Chấm 5 Amino Acid (Gly, Ala, Val, Lys, Glu) hoặc nhúng vào cốc chứa AA, sau đó nối với Nguồn điện DC ngoài để chạy điện di theo pH đệm & pI. Cuộn chuột chỉnh pH mượt (±0.20), Ctrl+Cuộn nhảy 5 mốc pH chuẩn, Shift+Cuộn đưa về 0 mm.',
    en: 'Spot 5 Amino Acids (Gly, Ala, Val, Lys, Glu) or dip into an AA vessel, then wire an external DC Power Supply to separate by buffer pH & pI. Scroll to adjust buffer pH (±0.20), Ctrl+Scroll to step 5 preset pHs, Shift+Scroll to reset lanes to 0 mm.',
  },
  retort_stand: {
    vi: 'Kéo bình cầu, ống nghiệm, buret, phễu chiết, ống sinh hàn hoặc đầu dò tới gần cột giá để kẹp cố định; kéo thanh trượt chiều cao để nâng/hạ cả cụm.',
    en: 'Drag flasks, test tubes, burettes, funnels, condensers, or digital probes onto the stand column to clamp them; slide height adjustment to raise/lower.',
  },
  filter_funnel: {
    vi: 'Đặt lên miệng bình hứng (hoặc kẹp lên Giá); rót hỗn hợp rắn–lỏng vào để giấy lọc giữ lại kết tủa/cặn rắn và cho nước lọc chảy xuống dưới.',
    en: 'Mount over a receiver vessel (or clamp on a Stand) and pour suspensions through it: filter paper retains solid precipitates while filtrate drains below.',
  },
  rubber_stopper: {
    vi: 'Kéo thả vào miệng bình để bịt kín (1 lỗ hoặc 2 lỗ cho ống dẫn khí & phễu chiết). Có nút van cao su tự bật nếu quá áp!',
    en: 'Drag onto a flask/tube rim to seal (solid, 1-hole, or 2-hole for gas tubing + separatory funnel). Pops off safely if internal overpressure builds!',
  },
  phen_cotton: {
    vi: 'Kẹp vào miệng bình đang sinh khí NH₃ hoặc acid để quan sát bông đổi màu hồng đậm/mất màu khi hơi kiềm thoát qua.',
    en: 'Attach at a vessel mouth to detect escaping NH₃ (turns bright pink) or acid vapors (decolorizes).',
  },
  flame_loop: {
    vi: 'Nhúng vòng dây Pt vào dung dịch chứa ion kim loại (Na⁺, K⁺, Ca²⁺, Ba²⁺, Cu²⁺, Li⁺, Sr²⁺...), sau đó đưa vào ngọn lửa đèn cồn/Bunsen để xem màu ngọn lửa đặc trưng!',
    en: 'Dip the Pt wire loop into a metal-ion solution (Na⁺, K⁺, Ca²⁺, Ba²⁺, Cu²⁺, Li⁺, Sr²⁺...), then hold it in a burner flame to observe characteristic atomic emission!',
  },
  splint: {
    vi: 'Chuyển trạng thái Đóm cháy / Đóm than hồng ở bảng phải rồi đưa vào miệng/lòng bình để thử khí O₂ (bùng cháy), H₂ (tiếng nổ pốp) hoặc CO₂ (tắt ngọn lửa).',
    en: 'Switch between Burning and Glowing Ember modes in the Inspector, then insert into vessel headspace to test for O₂ (relights), H₂ (pop), or CO₂ (extinguishes).',
  },
  litmus_paper: {
    vi: 'Kéo đầu giấy quỳ nhúng vào dung dịch hoặc đặt trên miệng bình khí ẩm để kiểm tra nhanh tính acid (đỏ), trung tính (tím), kiềm (xanh) hoặc tẩy trắng (Cl₂).',
    en: 'Dip into aqueous solution or moist headspace to test acidity (red), neutrality (purple), basicity (blue), or chlorine bleaching.',
  },
  ph_strip: {
    vi: 'Nhúng giấy chỉ thị pH vạn năng vào dung dịch để so màu chuẩn từ pH 1 đến 14 trên bảng đối chiếu.',
    en: 'Dip universal pH paper into solution and compare tip color against the pH 1–14 reference chart.',
  },
  thermometer: {
    vi: 'Nhúng đầu bầu nhiệt kế vào chất lỏng hoặc lòng bình khí/bể nhiệt để đo nhiệt độ (°C / K) trực tiếp.',
    en: 'Insert the thermometer bulb into any vessel liquid, headspace, or thermal bath to read live °C / K.',
  },
  mortar_pestle: {
    vi: 'Cho chất rắn dạng khối/hạt (CaCO₃, tinh thể, hạt gạo, bông...) vào cối, bấm "Nghiền mịn" (hoặc Shift+Cuộn chuột) để tăng diện tích bề mặt phản ứng, rồi trút sang bình.',
    en: 'Add coarse solids (CaCO₃, crystals, rice grains, cotton...) into the mortar, click Grind (or Shift+Scroll) to pulverize into fine powder, then pour into a vessel.',
  },
  iron_spoon: {
    vi: 'Kéo vào bình có chất rắn để múc hóa chất (hoặc đong trực tiếp), có thể đốt trực tiếp trên đèn rồi đưa sâu vào bình khí (O₂, Cl₂) hoặc trút vào bình khác.',
    en: 'Drag into a solid-containing vessel to scoop, heat directly over a burner, lower into gas jars (O₂, Cl₂), or dump into another vessel.',
  },
  wash_bottle: {
    vi: 'Nhấn giữ nút Xịt trên bảng phải hoặc khi kéo nhắm vào miệng bình để phun tia nước cất theo quỹ đạo parabol rửa thành/pha loãng.',
    en: 'Hold Spray in the Inspector or aim the nozzle at a vessel to rinse walls and add deionized water along a parabolic jet.',
  },
  diffusion_tube: {
    vi: 'Kéo thả dung dịch HCl 37% và NH₃ 25% vào 2 đầu trái/phải ống thủy tinh nằm ngang để quan sát khói trắng NH₄Cl tạo vòng kết tinh theo định luật Graham.',
    en: 'Drop 37% HCl and 25% NH₃ onto opposite ends of the horizontal glass tube to watch white NH₄Cl smoke ring form per Graham’s diffusion law.',
  },
  crucible_porcelain: {
    vi: 'Dùng để nung nhiệt cao (>800–1300 °C) trên đèn Bunsen xanh (nhiệt phân CaCO₃, nung quặng/muối). Nhấn Shift+Cuộn hoặc nút Nắp chén để mở/hé/đậy nắp.',
    en: 'Built for extreme calcination (>800–1300 °C) over a blue Bunsen flame. Use Inspector or Shift+Scroll to cycle lid open / ajar / closed.',
  },
  quartz_tube: {
    vi: 'Kéo thả chất rắn (như CuO) vào trong ống rồi gắn ống dẫn khí H₂/CO đi qua và đặt lên Đèn Bunsen để thực hiện phản ứng khử dòng khí nóng.',
    en: 'Load solids (e.g., CuO) inside, connect H₂/CO gas tubing across the ends, and heat with a Bunsen burner for continuous gas-solid reduction.',
  },
  quartz_u_tube: {
    vi: 'Dùng làm ống chữ U chứa chất hút ẩm (CaCl₂ khan, P₄O₁₀) hoặc ngưng tụ lạnh khi nhúng phần đáy chữ U vào Bể đá.',
    en: 'U-shaped quartz trap for drying gases or freezing condensables when the bottom U-bend is immersed in an Ice Bath.',
  },
  water_trough: {
    vi: 'Đổ nước vào chậu rồi úp ngược Ống nghiệm/Bình cầu/Ống đong (Shift+Lăn hoặc lật ngược) xuống nước và dẫn ống khí vào đáy để thu khí đẩy nước.',
    en: 'Fill with water, invert a tube/cylinder into the trough, and route gas tubing underneath to collect gases by water displacement.',
  },
  burner: {
    vi: 'Bật công tắc 3 mức lửa và đặt bình/kiềng lên phía trên để đun nhẹ đến trung bình (~400–750 °C) trong các thí nghiệm hòa tan, đun sôi, tráng bạc.',
    en: 'Select flame level 1–3 and place vessels above for gentle-to-moderate heating (~400–750 °C) in dissolution, boiling, or silver-mirror tests.',
  },
};

const VESSEL_USAGE_GUIDE = {
  vi: '• Kéo thả hóa chất từ cột trái vào bình hoặc chọn bình rồi bấm để đong chính xác.\n• Lăn chuột trên bình để nghiêng rót sang bình/phễu/buret khác; Shift+Lăn để lật/đóng mở nắp.\n• Kết nối ống dẫn khí từ bình này sang bình khác hoặc Gas Syringe khi có nút cao su có lỗ.',
  en: '• Drag reagents onto this vessel or select it and click a reagent for exact dosing.\n• Scroll mouse wheel over the vessel to tilt & pour into another vessel/funnel/burette.\n• Connect gas tubing between holed rubber stoppers or to a Gas Syringe.',
};

export function getApparatusUsageGuide(typeId, langCode = 'vi') {
  const isEn = langCode === 'en';
  const entry = APPARATUS_USAGE_GUIDES[typeId] || VESSEL_USAGE_GUIDE;
  return isEn ? entry.en : entry.vi;
}
