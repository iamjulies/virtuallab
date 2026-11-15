# ChemLab Studio — `virlab_beta_v1`

Phòng thí nghiệm Hóa học Ảo tương tác tự do (Freeform Virtual Chemistry Lab) mô phỏng theo thời gian thực với động cơ hóa lý chuẩn IUPAC, hỗ trợ **Tiếng Việt / English**, **Dark / Light Theme**, **Responsive (Desktop / Tablet / Mobile)** và **PWA (cài đặt như App)**.

## Tính năng nổi bật (`virlab_beta_v1`)
- **Tự do thiết lập bàn thí nghiệm:** Kéo thả dụng cụ (`Beaker 250 mL`, `Erlenmeyer Flask 250 mL`, `Test Tube 50 mL`, `Graduated Cylinder 100 mL`, `Electronic Balance 0.01 g`, `Alcohol Burner`, `Gas Syringe 250 mL`, `Pipette 10 mL`).
- **Hóa chất nguyên chất chuẩn IUPAC:** Cung cấp dạng bền nhất (`Water`, `Sodium` trong dầu khoáng, `Zinc`, `Copper(II) sulfate pentahydrate`, `Silver nitrate`, `Sodium hydroxide`, `Hydrochloric acid 37%`, `Phenolphthalein 1%`) để người dùng tự cân, pha chế và điều chế.
- **Động cơ Hóa Lý Thời Gian Thực:**
  - Phản ứng đồng thời & dây chuyền (ví dụ `Na` + dung dịch `AgNO₃` tự pha $\rightarrow$ sinh `H₂↑` + `OH⁻` $\rightarrow$ kết tủa `Ag₂O↓` nâu đen).
  - Cân bằng số mol cạnh tranh, động học Arrhenius theo nhiệt độ, cân bằng $\text{pH}$ chính xác theo $K_w(T)$, đổi màu chỉ thị Henderson–Hasselbalch và quang học Beer–Lambert.
  - Điểm sôi phụ thuộc áp suất theo phương trình Antoine, cân bằng nhiệt $\Delta H$, định luật khí lý tưởng $PV = nRT$ với hệ hở vs hệ kín nối ống thu khí `Gas syringe`, và cảnh báo quá áp (bật nút / vỡ bình).
- **Điều kiện phòng thí nghiệm tùy chỉnh:** Mặc định chuẩn SATP `298.15 K (25.0 °C)` và `1.00 bar`.

## Chạy cục bộ (Local)
```bash
python -m http.server 8000
```
Mở `http://localhost:8000/index.html` (và `http://localhost:8000/tests/engine_verify.html` để chạy bộ kiểm thử tự động).
