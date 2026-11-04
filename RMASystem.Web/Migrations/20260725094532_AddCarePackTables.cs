using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class AddCarePackTables : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CarePackBatches",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    InvoiceNumber = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    ZohoInvoiceId = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    CustomerName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    CustomerCity = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    InvoiceDate = table.Column<DateOnly>(type: "date", nullable: true),
                    Irn = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    IrnAckNo = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    IrnAckDate = table.Column<DateTime>(type: "datetime", nullable: true),
                    OemBrand = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    CarePackType = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    PrinterModel = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    InvoiceItemName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    InvoiceDescriptionRaw = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    InvoiceBrandDetected = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    InvoiceQty = table.Column<int>(type: "int", nullable: false),
                    DeviceCount = table.Column<int>(type: "int", nullable: false),
                    Status = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: false),
                    PurchaseOrderNumber = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    ZohoPurchaseOrderId = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    PoValidatedAt = table.Column<DateTime>(type: "datetime", nullable: true),
                    PoValidatedBy = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    PoMatched = table.Column<bool>(type: "bit", nullable: false),
                    PoValidationNotes = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    OemInvoiceNumber = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    OemInvoiceDate = table.Column<DateOnly>(type: "date", nullable: true),
                    InstallationDate = table.Column<DateOnly>(type: "date", nullable: true),
                    ValidationReportPath = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    Overridden = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false),
                    CreatedBy = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CarePackBatches", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "CarePackDevices",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    CarePackBatchId = table.Column<int>(type: "int", nullable: false),
                    SerialNumber = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    OemBrand = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    CarePackType = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    OriginalModel = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    WarrantyEnd = table.Column<DateOnly>(type: "date", nullable: true),
                    InvoiceItemName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    InvoiceBrandDetected = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    InvoiceDescriptionRaw = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    Irn = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    IrnAckNo = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    IrnAckDate = table.Column<DateTime>(type: "datetime", nullable: true),
                    Overridden = table.Column<bool>(type: "bit", nullable: false),
                    OverrideBy = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    OverrideAt = table.Column<DateTime>(type: "datetime", nullable: true),
                    OverrideReason = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    OverrideConfirmed = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CarePackDevices", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CarePackDevices_CarePackBatches_CarePackBatchId",
                        column: x => x.CarePackBatchId,
                        principalTable: "CarePackBatches",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_InvoiceNumber",
                table: "CarePackBatches",
                column: "InvoiceNumber",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_CarePackDevices_CarePackBatchId",
                table: "CarePackDevices",
                column: "CarePackBatchId");

            migrationBuilder.CreateIndex(
                name: "IX_CarePackDevices_SerialNumber",
                table: "CarePackDevices",
                column: "SerialNumber");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CarePackDevices");

            migrationBuilder.DropTable(
                name: "CarePackBatches");
        }
    }
}
