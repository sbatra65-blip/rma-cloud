using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AppSettings",
                columns: table => new
                {
                    Key = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: false),
                    Value = table.Column<string>(type: "nvarchar(max)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AppSettings", x => x.Key);
                });

            migrationBuilder.CreateTable(
                name: "ImportLogs",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ImportedAt = table.Column<DateTime>(type: "datetime", nullable: false),
                    Filename = table.Column<string>(type: "nvarchar(255)", maxLength: 255, nullable: true),
                    TotalRows = table.Column<int>(type: "int", nullable: false),
                    ImportedCount = table.Column<int>(type: "int", nullable: false),
                    DuplicateCount = table.Column<int>(type: "int", nullable: false),
                    ErrorCount = table.Column<int>(type: "int", nullable: false),
                    SummaryText = table.Column<string>(type: "nvarchar(max)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ImportLogs", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "MonthlyBatches",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    BatchId = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: false),
                    BatchMonth = table.Column<string>(type: "nvarchar(7)", maxLength: 7, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false),
                    DispatchDate = table.Column<DateOnly>(type: "date", nullable: true),
                    TotalRmas = table.Column<int>(type: "int", nullable: false),
                    Remarks = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    ExcelPath = table.Column<string>(type: "nvarchar(max)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MonthlyBatches", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "RMATickets",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    InternalTicketNo = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    IsImported = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime", nullable: false),
                    CustomerCompany = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    CustomerAddress = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    CustomerCity = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    CustomerPostal = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: true),
                    CustomerCountry = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    CustomerContactName = table.Column<string>(type: "nvarchar(150)", maxLength: 150, nullable: true),
                    CustomerEmail = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    CustomerPhone = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    PoNumber = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    ShipToCompany = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    ShipToAddress = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    ShipToContactName = table.Column<string>(type: "nvarchar(150)", maxLength: 150, nullable: true),
                    ShipToEmail = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    ShipToPhone = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    PrinterModel = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    PrinterSn = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    FaultyPart = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    FaultyPartSn = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    FaultyPartNo = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    FailureDescription = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    TphMileage = table.Column<decimal>(type: "decimal(10,2)", nullable: true),
                    PrinterMileage = table.Column<decimal>(type: "decimal(10,2)", nullable: true),
                    FwVersion = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    FlashInitialized = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: true),
                    PurchaseDate = table.Column<DateOnly>(type: "date", nullable: true),
                    DeliveryToUserDate = table.Column<DateOnly>(type: "date", nullable: true),
                    OemRmaNumber = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    OemRmaAssignDate = table.Column<DateOnly>(type: "date", nullable: true),
                    OemEmailReceivedAt = table.Column<DateTime>(type: "datetime", nullable: true),
                    OemDispatchDate = table.Column<DateOnly>(type: "date", nullable: true),
                    BatchDispatchId = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: true),
                    ZohoChallanId = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    ZohoChallanNumber = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    ChallanCreatedAt = table.Column<DateTime>(type: "datetime", nullable: true),
                    DispatchToCustomerDate = table.Column<DateOnly>(type: "date", nullable: true),
                    ClosedAt = table.Column<DateTime>(type: "datetime", nullable: true),
                    ClosureType = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: true),
                    ClosureRemarks = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    ExcelFilePath = table.Column<string>(type: "nvarchar(max)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RMATickets", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "RMAPhotos",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    RmaTicketId = table.Column<int>(type: "int", nullable: false),
                    Direction = table.Column<string>(type: "nvarchar(10)", maxLength: 10, nullable: false),
                    Filename = table.Column<string>(type: "nvarchar(255)", maxLength: 255, nullable: false),
                    FilePath = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    CapturedAt = table.Column<DateTime>(type: "datetime", nullable: false),
                    CapturedBy = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    Notes = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    EmbeddedInExcel = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RMAPhotos", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RMAPhotos_RMATickets_RmaTicketId",
                        column: x => x.RmaTicketId,
                        principalTable: "RMATickets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                table: "AppSettings",
                columns: new[] { "Key", "Value" },
                values: new object[,]
                {
                    { "base_dir", "C:\\Sanjay Projects\\Projects\\RMA Windows" },
                    { "company_address", "312, VISHWADEEP TOWER" },
                    { "company_city", "New Delhi" },
                    { "company_contact", "Sanjay Batra" },
                    { "company_country", "INDIA" },
                    { "company_email", "sanjay@infinitesolutions.co.in" },
                    { "company_name", "INFINITE SOLUTIONS" },
                    { "company_phone", "9311011467" },
                    { "company_postal", "110058" },
                    { "oem_address", "No. 285, Shulin Dist., New Taipei City 23860, Taiwan" },
                    { "oem_email", "tsc_rma@tscprinters.com" },
                    { "oem_fax", "+886-2-2267-5581" },
                    { "oem_name", "TSC Auto ID Technology Co., Ltd." },
                    { "oem_phone", "+886-2-2267-6000" },
                    { "setup_complete", "false" },
                    { "ticket_prefix", "INF" },
                    { "zoho_books_org_id", "" },
                    { "zoho_books_refresh_token", "" },
                    { "zoho_client_id", "" },
                    { "zoho_client_secret", "" },
                    { "zoho_mail_refresh_token", "" },
                    { "zoho_poll_interval_mins", "30" }
                });

            migrationBuilder.CreateIndex(
                name: "IX_MonthlyBatches_BatchId",
                table: "MonthlyBatches",
                column: "BatchId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_RMAPhotos_RmaTicketId",
                table: "RMAPhotos",
                column: "RmaTicketId");

            migrationBuilder.CreateIndex(
                name: "IX_RMATickets_InternalTicketNo",
                table: "RMATickets",
                column: "InternalTicketNo",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AppSettings");

            migrationBuilder.DropTable(
                name: "ImportLogs");

            migrationBuilder.DropTable(
                name: "MonthlyBatches");

            migrationBuilder.DropTable(
                name: "RMAPhotos");

            migrationBuilder.DropTable(
                name: "RMATickets");
        }
    }
}
