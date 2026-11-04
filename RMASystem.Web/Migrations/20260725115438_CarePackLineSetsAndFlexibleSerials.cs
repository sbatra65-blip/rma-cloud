using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class CarePackLineSetsAndFlexibleSerials : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_CarePackBatches_InvoiceNumber",
                table: "CarePackBatches");

            migrationBuilder.AddColumn<int>(
                name: "LineSetIndex",
                table: "CarePackBatches",
                type: "int",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<string>(
                name: "PrinterItemName",
                table: "CarePackBatches",
                type: "nvarchar(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_InvoiceNumber_LineSetIndex",
                table: "CarePackBatches",
                columns: new[] { "InvoiceNumber", "LineSetIndex" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_CarePackBatches_InvoiceNumber_LineSetIndex",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "LineSetIndex",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "PrinterItemName",
                table: "CarePackBatches");

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_InvoiceNumber",
                table: "CarePackBatches",
                column: "InvoiceNumber",
                unique: true);
        }
    }
}
